#pragma once
#include "clipboard.h"
#include "clipboard_policy.h"
#include "transient.h"
#include <functional>

namespace highlighter {
class ClipboardTransaction {
  public:
    ClipboardTransaction(HWND target, const CoordinatorConfig &config, bool mayWait, std::function<bool()> stopping);
    ~ClipboardTransaction();
    ClipboardTransaction(const ClipboardTransaction &) = delete;
    bool ready() const;
    void observe(DWORD sequence);
    bool read(std::wstring &text);
    void complete() { finish(); }
  private:
    ClipboardStamp stamp() const;
    bool current() const;
    void finish();
    HWND target_, owner_ = nullptr;
    DWORD targetPid_ = 0;
    uint64_t input_;
    bool strict_, cleared_ = false, finished_ = false;
    std::function<bool()> stopping_;
    TransientLease lease_;
    ClipboardBackup backup_;
    std::unique_ptr<RestorePolicy> policy_;
    std::array<DWORD,5> anchors_{};
};
}
