#include "clipboard_transaction.h"

namespace highlighter {
namespace {
DWORD ownerPid() { DWORD pid = 0; const HWND owner = GetClipboardOwner(); if (owner) GetWindowThreadProcessId(owner, &pid); return pid; }
struct CloseGuard { ~CloseGuard() { CloseClipboard(); } };
}
ClipboardTransaction::ClipboardTransaction(HWND target, const CoordinatorConfig &config, bool mayWait, std::function<bool()> stopping)
    : target_(target), input_(InputSerial()), strict_(config.required), stopping_(std::move(stopping)), lease_(config, mayWait)
{
    GetWindowThreadProcessId(target_, &targetPid_);
    const DWORD before = GetClipboardSequenceNumber();
    policy_ = std::make_unique<RestorePolicy>(before, input_, targetPid_, GetCurrentProcessId());
    if (!current()) return;
    owner_ = CreateWindowExW(0,L"STATIC",L"",0,0,0,0,0,HWND_MESSAGE,nullptr,nullptr,nullptr);
    if (!owner_ || !OpenClipboard(owner_)) return;
    CloseGuard close;
    if (!current() || !policy_->mayClear(GetClipboardSequenceNumber(), InputSerial())) return;
    if (!BackupClipboard(backup_, true)) { RecordTransient(TransientEvent::BackupRejected); return; }
    // Delayed rendering may block or change sequence during backup. Recheck
    // while still holding the same OpenClipboard interval before the first write.
    if (!current() || !policy_->mayClear(GetClipboardSequenceNumber(), InputSerial())) return;
    anchors_[0] = GetClipboardSequenceNumber();
    if (!EmptyClipboard()) return;
    anchors_[1] = GetClipboardSequenceNumber();
    policy_->cleared(anchors_[1]);
    cleared_ = true;
}
ClipboardTransaction::~ClipboardTransaction() { finish(); if (owner_) DestroyWindow(owner_); }
bool ClipboardTransaction::current() const { return targetPid_ && !stopping_() && lease_.valid() && InputSerial() == input_ && GetForegroundWindow() == target_; }
bool ClipboardTransaction::ready() const { return cleared_ && current(); }
ClipboardStamp ClipboardTransaction::stamp() const { return {GetClipboardSequenceNumber(), ownerPid(), InputSerial()}; }
void ClipboardTransaction::observe(DWORD sequence) { policy_->observePublication(sequence); }
bool ClipboardTransaction::read(std::wstring &text) {
    if (!ready() || !OpenClipboard(owner_)) return false;
    CloseGuard close;
    const auto before = stamp();
    if (!current() || !policy_->read(before, strict_)) return false;
    const bool success = ReadClipboard(text, true);
    const auto after = stamp();
    anchors_[2] = after.sequence;
    if (!current() || before.sequence != after.sequence || before.ownerPid != after.ownerPid || before.input != after.input) {
        policy_->ambiguous(); text.clear(); return false;
    }
    return success && !text.empty();
}
void ClipboardTransaction::finish() {
    if (finished_) return;
    finished_ = true;
    DWORD outcome = 2;  // interrupted/no mutation
    if (cleared_) {
        if (InputSerial() != input_) RecordTransient(TransientEvent::InputInterrupted);
        outcome = 3;  // unknown interleaving until proven safe
        if (lease_.valid() && OpenClipboard(owner_)) {
            CloseGuard close;
            const auto before = stamp();
            anchors_[3] = before.sequence;
            // This is the authoritative comparison, under the same lock as
            // EmptyClipboard/SetClipboardData; no check-then-open race.
            if (policy_->mayRestore(before) && (before.ownerPid == GetCurrentProcessId() || GetForegroundWindow() == target_)) {
                const bool restored = RestoreClipboard(backup_, true, [&]() { return lease_.valid() && InputSerial() == before.input; });
                outcome = restored ? 1 : 3;
                RecordTransient(restored ? TransientEvent::Restored : TransientEvent::RestoreFailed);
            }
            anchors_[4] = GetClipboardSequenceNumber();
        }
    }
    if (outcome == 3) RecordTransient(TransientEvent::Ambiguous);
    lease_.finish(anchors_, outcome);
}
}
