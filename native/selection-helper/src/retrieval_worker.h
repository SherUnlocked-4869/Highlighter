/**
 * @file
 * @brief R0-04 extraction adapter: MTA retrieval executor without Node-API.
 *
 * This is the only file in the helper that replaces a part of vendor/selection-hook:
 * vendor/core/worker.{h,cc} cannot be reused because it depends on napi.h and on a
 * napi_threadsafe_function handoff to the Node event loop. Everything else in
 * vendor/core (SelectionEngine) and vendor/lib is compiled verbatim.
 *
 * Differences from vendor/core/worker.cc, and why:
 *  1. Results are delivered through a value-only std::function sink instead of a TSFN.
 *  2. Shutdown reports the abandoned-worker case to the caller (return value) instead
 *     of PinCurrentModule(), because the helper is a short-lived process and exits.
 *  3. The readiness handshake, one-pending-request slot, bounded 2 s stop and
 *     stop-aware stage tracking are preserved so behavior can be compared 1:1.
 *
 * @warning Thread affinity is unchanged: the IUIAutomation client is created, used and
 * released on this worker thread only. No COM interface crosses the thread boundary.
 */
#pragma once

#define WIN32_LEAN_AND_MEAN 1

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "core/engine.h"
#include "core/types.h"

namespace helper
{

/** @brief Result of the startup handshake and of one UIA probe on the worker thread. */
struct RetrievalWorkerSelfTest
{
    bool ready = false;
    /** HRESULT of CoCreateInstance(CUIAutomation) as a plain long (HRESULT is long). */
    long initializationHr = 0;
    bool uiaProbeOk = false;
    long rootControlType = 0;
    std::wstring rootName;
    std::string error;
};

/** @brief Value-only result callback executed on the retrieval worker thread. */
using RetrievalResultSink =
    std::function<void(const SelectionWorkerResult &result, RetrievalStage stage, unsigned long long elapsedMs)>;

/**
 * @brief Long-lived single-thread MTA executor for automatic selection retrieval.
 *
 * Mirrors vendor/core/worker.cc minus N-API. One pending request only: the caller's
 * auto gate must not build a backlog of stale mouse gestures.
 */
class RetrievalWorker
{
  public:
    RetrievalWorker(std::shared_ptr<RetrievalGates> gates, RetrievalResultSink sink);
    ~RetrievalWorker();

    RetrievalWorker(const RetrievalWorker &) = delete;
    RetrievalWorker &operator=(const RetrievalWorker &) = delete;

    /**
     * @brief Start the worker and wait for its COM/UIA readiness handshake.
     * @param[out] selfTest Startup handshake details (HRESULT + root-element probe).
     * @param[out] error Human-readable initialization error on failure.
     * @return true only after the worker thread created its MTA UIA client.
     */
    bool Start(RetrievalWorkerSelfTest &selfTest, std::string &error);

    /** @brief Submit a value-only automatic retrieval request (single pending slot). */
    bool Enqueue(SelectionRequest request);

    /**
     * @brief Stop accepting work and join, or abandon after the 2 s bound.
     * @return true when the worker thread was joined, false when it was abandoned.
     */
    bool Stop();

  private:
    struct State;
    static void ThreadMain(const std::shared_ptr<State> &state);

    std::shared_ptr<State> state_;
    std::thread thread_;
};

}  // namespace helper
