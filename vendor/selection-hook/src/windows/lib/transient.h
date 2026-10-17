#pragma once
#include <windows.h>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace highlighter {
struct CoordinatorConfig {
    bool required = false;
    std::wstring pipe;
    std::array<BYTE, 32> nonce{}, hostEpoch{};
    DWORD serverPid = 0;
    std::shared_ptr<std::atomic<uint64_t>> revision = std::make_shared<std::atomic<uint64_t>>(0);
    uint64_t expectedRevision = 0;
    bool current() const { return revision->load(std::memory_order_acquire) == expectedRevision; }
};

uint64_t InputSerial();
ULONG_PTR InputTag();
void ObserveInput(const KBDLLHOOKSTRUCT &event, WPARAM message);
enum class TransientEvent { LeaseDenied, BackupRejected, InputInterrupted, Ambiguous, Restored, RestoreFailed, Count };
void RecordTransient(TransientEvent event);
std::array<uint64_t,6> TransientDiagnostics();

// All blocking I/O runs on a retrieval/health worker. No N-API or HWND dispatch.
class TransientLease {
  public:
    TransientLease(const CoordinatorConfig &config, bool mayWait);
    ~TransientLease();
    TransientLease(const TransientLease &) = delete;
    TransientLease &operator=(const TransientLease &) = delete;
    bool valid() const;
    bool finish(const std::array<DWORD, 5> &anchors, DWORD outcome);
  private:
    bool exchange(const std::array<BYTE, 128> &request, std::array<BYTE, 32> &response, ULONGLONG deadline);
    std::array<BYTE, 128> packet(DWORD method) const;
    CoordinatorConfig config_;
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    bool granted_ = false;
    bool everGranted_ = false;
    uint64_t transaction_ = 0, generation_ = 0;
    ULONGLONG deadline_ = 0;
};
}
