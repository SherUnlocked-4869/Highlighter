#include "transient.h"
#include <algorithm>
#include <cstring>

namespace highlighter {
namespace {
std::atomic<uint64_t> inputSerial{0};
std::array<std::atomic<uint64_t>,6> diagnostics{};
std::atomic<uint64_t> nextTransaction{GetTickCount64() << 16};
struct Event { HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr); ~Event() { if (value) CloseHandle(value); } };
template<class T, size_t N> void put(std::array<BYTE, N> &bytes, size_t offset, T value) { memcpy(bytes.data() + offset, &value, sizeof(value)); }
template<class T, size_t N> T get(const std::array<BYTE, N> &bytes, size_t offset) { T value{}; memcpy(&value, bytes.data() + offset, sizeof(value)); return value; }
bool complete(HANDLE pipe, OVERLAPPED &operation, BOOL started, DWORD &transferred, ULONGLONG deadline) {
    if (!started && GetLastError() != ERROR_IO_PENDING) return false;
    if (!started) {
        const ULONGLONG now = GetTickCount64();
        const DWORD remaining = deadline > now ? static_cast<DWORD>(std::min<ULONGLONG>(deadline - now, 100)) : 0;
        if (WaitForSingleObject(operation.hEvent, remaining) != WAIT_OBJECT_0) {
            CancelIoEx(pipe, &operation);
            // The OVERLAPPED and buffer must outlive kernel completion.
            GetOverlappedResult(pipe, &operation, &transferred, TRUE);
            return false;
        }
    }
    return GetOverlappedResult(pipe, &operation, &transferred, FALSE) != FALSE;
}
}

uint64_t InputSerial() { return inputSerial.load(std::memory_order_acquire); }
void RecordTransient(TransientEvent event) { diagnostics[static_cast<size_t>(event)].fetch_add(1, std::memory_order_relaxed); }
std::array<uint64_t,6> TransientDiagnostics() {
    std::array<uint64_t,6> result{};
    for (size_t i=0; i<result.size(); ++i) result[i] = diagnostics[i].load(std::memory_order_relaxed);
    return result;
}
ULONG_PTR InputTag() { return reinterpret_cast<ULONG_PTR>(&inputSerial); }
void ObserveInput(const KBDLLHOOKSTRUCT &event, WPARAM message) {
    if (message != WM_KEYDOWN && message != WM_SYSKEYDOWN) return;
    if ((event.flags & LLKHF_INJECTED) && event.dwExtraInfo == InputTag()) return;
    // Count before retrieval-event filtering. Fast down/up pairs and other tools'
    // injected shortcuts must remain visible even while JS receives no events.
    inputSerial.fetch_add(1, std::memory_order_acq_rel);
}

std::array<BYTE,128> TransientLease::packet(DWORD method) const {
    std::array<BYTE,128> bytes{};
    memcpy(bytes.data(), "HLC1", 4);
    put(bytes, 4, method); put(bytes, 8, transaction_);
    memcpy(bytes.data()+16, config_.nonce.data(), 32);
    memcpy(bytes.data()+48, config_.hostEpoch.data(), 32);
    if (method != 1) put(bytes, 80, generation_);
    return bytes;
}

TransientLease::TransientLease(const CoordinatorConfig &config, bool mayWait) : config_(config) {
    if (!config_.current()) return;
    if (!config_.required) { granted_ = everGranted_ = true; return; }
    if (!mayWait || config_.pipe.empty() || config_.serverPid == 0) return;
    const ULONGLONG beginDeadline = GetTickCount64() + 100;
    while (GetTickCount64() < beginDeadline && config_.current()) {
        pipe_ = CreateFileW(config_.pipe.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
        if (pipe_ != INVALID_HANDLE_VALUE) break;
        if (GetLastError() != ERROR_PIPE_BUSY) return;
        Sleep(1);
    }
    if (pipe_ == INVALID_HANDLE_VALUE) return;
    ULONG serverPid = 0;
    if (!GetNamedPipeServerProcessId(pipe_, &serverPid) || serverPid != config_.serverPid) return;
    DWORD mode = PIPE_READMODE_MESSAGE;
    if (!SetNamedPipeHandleState(pipe_, &mode, nullptr, nullptr)) return;
    transaction_ = nextTransaction.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::array<BYTE,32> response{};
    if (!exchange(packet(1), response, beginDeadline)) return;
    generation_ = get<uint64_t>(response, 16);
    if (!generation_ || get<DWORD>(response, 24) < 1500) return;
    // Shorter than the server's 2s lease, including the entire grant handshake.
    deadline_ = beginDeadline - 100 + 1500;
    granted_ = true;
    everGranted_ = true;
}
TransientLease::~TransientLease() {
    if (config_.required && !everGranted_) RecordTransient(TransientEvent::LeaseDenied);
    if (pipe_ != INVALID_HANDLE_VALUE) CloseHandle(pipe_);
}

bool TransientLease::valid() const {
    if (!granted_ || !config_.current()) return false;
    if (!config_.required) return true;
    return GetTickCount64() < deadline_ && PeekNamedPipe(pipe_, nullptr, 0, nullptr, nullptr, nullptr) != FALSE;
}

bool TransientLease::exchange(const std::array<BYTE,128> &request, std::array<BYTE,32> &response, ULONGLONG deadline) {
    Event event;
    if (!event.value) return false;
    OVERLAPPED operation{}; operation.hEvent = event.value;
    DWORD transferred = 0;
    const BOOL written = WriteFile(pipe_, request.data(), static_cast<DWORD>(request.size()), nullptr, &operation);
    if (!complete(pipe_, operation, written, transferred, deadline) || transferred != request.size()) return false;
    ResetEvent(event.value);
    operation = {}; operation.hEvent = event.value;
    const BOOL read = ReadFile(pipe_, response.data(), static_cast<DWORD>(response.size()), nullptr, &operation);
    return complete(pipe_, operation, read, transferred, deadline) && transferred == response.size()
        && memcmp(response.data(), "HLC1", 4) == 0 && get<DWORD>(response,4) == 0
        && get<uint64_t>(response,8) == transaction_ && get<DWORD>(response,28) == 0;
}

bool TransientLease::finish(const std::array<DWORD,5> &anchors, DWORD outcome) {
    if (!granted_) return false;
    granted_ = false;
    if (!config_.required) return true;
    auto request = packet(2);
    for (size_t index=0; index<anchors.size(); ++index) put(request, 88+index*4, anchors[index]);
    put(request,108,outcome);
    std::array<BYTE,32> response{};
    return exchange(request, response, GetTickCount64()+100) && get<uint64_t>(response,16) == generation_;
}
}
