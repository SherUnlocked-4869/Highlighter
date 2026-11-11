/**
 * @file
 * @brief R0-04 extraction adapter implementation: MTA retrieval executor minus N-API.
 */
#define WIN32_LEAN_AND_MEAN 1
#define NOMINMAX 1

#include "retrieval_worker.h"

#include <UIAutomation.h>
#include <windows.h>

#include "lib/utils.h"  // IsTrimmedEmpty

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <utility>

namespace helper
{
namespace
{
// Same budgets and bounds as vendor/core/worker.cc: a start() must not report success
// before COM/UIA are actually usable, and a provider that never returns must not block
// host shutdown forever.
constexpr DWORD kWorkerReadyTimeoutMs = 5000;
constexpr DWORD kWorkerStopTimeoutMs = 2000;
constexpr unsigned int kMaxAbandonedWorkers = 4;
std::atomic<unsigned int> g_abandonedWorkerCount{0};

const char *StageName(RetrievalStage stage)
{
    switch (stage)
    {
        case RetrievalStage::Idle:
            return "idle";
        case RetrievalStage::ProgramName:
            return "program-name";
        case RetrievalStage::UIAutomation:
            return "uia";
        case RetrievalStage::Accessible:
            return "msaa";
        case RetrievalStage::Clipboard:
            return "clipboard";
        case RetrievalStage::ClipboardPoll:
            return "clipboard-poll";
        case RetrievalStage::Complete:
            return "complete";
    }
    return "unknown";
}

/** Release the shared auto gate natively, independent of result delivery. */
class AutoGateGuard
{
  public:
    explicit AutoGateGuard(const std::shared_ptr<RetrievalGates> &gates) : gates_(gates) {}
    ~AutoGateGuard()
    {
        if (gates_)
            gates_->autoRetrievalInFlight.store(false, std::memory_order_release);
    }

  private:
    std::shared_ptr<RetrievalGates> gates_;
};
}  // namespace

struct RetrievalWorker::State
{
    // Lock order: no nested napi mutex exists here, so only mutex/napiMutex/equivalent
    // rules from the original file collapse into one mutex.
    std::mutex mutex;
    std::condition_variable cv;
    std::condition_variable readyCv;
    std::condition_variable completionCv;
    std::unique_ptr<SelectionRequest> pendingRequest;
    bool ready = false;
    bool completed = false;
    long initializationResult = E_PENDING;
    RetrievalWorkerSelfTest selfTest;
    std::shared_ptr<RetrievalGates> gates;
    RetrievalResultSink sink;
    std::atomic<bool> accepting{true};
    std::atomic<bool> stopRequested{false};
    std::atomic<bool> abandoned{false};
    std::atomic<RetrievalStage> stage{RetrievalStage::Idle};
    std::atomic<HWND> retrievalHwnd{NULL};
    std::atomic<ULONGLONG> retrievalStartedAt{0};
};

RetrievalWorker::RetrievalWorker(std::shared_ptr<RetrievalGates> gates, RetrievalResultSink sink)
{
    state_ = std::make_shared<State>();
    state_->gates = std::move(gates);
    state_->sink = std::move(sink);
}

RetrievalWorker::~RetrievalWorker()
{
    Stop();
}

bool RetrievalWorker::Start(RetrievalWorkerSelfTest &selfTest, std::string &error)
{
    if (!state_ || !state_->gates || !state_->sink)
    {
        error = "Invalid selection worker state";
        return false;
    }
    if (g_abandonedWorkerCount.load(std::memory_order_acquire) >= kMaxAbandonedWorkers)
    {
        error = "Selection worker abandoned-thread limit reached";
        return false;
    }

    try
    {
        thread_ = std::thread(&RetrievalWorker::ThreadMain, state_);
    }
    catch (...)
    {
        error = "Failed to create selection MTA worker";
        return false;
    }

    std::unique_lock<std::mutex> lock(state_->mutex);
    const bool ready = state_->readyCv.wait_for(lock, std::chrono::milliseconds(kWorkerReadyTimeoutMs),
                                                [state = state_] { return state->ready; });
    selfTest = state_->selfTest;
    lock.unlock();
    if (!ready)
    {
        error = "Timed out initializing selection MTA worker";
        Stop();
        return false;
    }
    if (FAILED(static_cast<HRESULT>(state_->initializationResult)))
    {
        error = "Failed to initialize selection MTA worker COM/UIA";
        Stop();
        return false;
    }
    return true;
}

bool RetrievalWorker::Enqueue(SelectionRequest request)
{
    const std::shared_ptr<State> state = state_;
    if (!state || !state->accepting.load(std::memory_order_acquire) ||
        state->stopRequested.load(std::memory_order_acquire))
        return false;

    // Reject rather than queue a backlog: the hook historically suppressed new input
    // while selection retrieval was in flight, and the auto gate preserves that rule.
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->accepting.load(std::memory_order_relaxed) || state->pendingRequest)
        return false;
    state->pendingRequest = std::make_unique<SelectionRequest>(std::move(request));
    state->cv.notify_one();
    return true;
}

bool RetrievalWorker::Stop()
{
    const std::shared_ptr<State> state = state_;
    if (!state)
        return true;

    // First prevent new work, then discard a request that has not started.
    state->accepting.store(false, std::memory_order_release);
    state->stopRequested.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->pendingRequest.reset();
    }
    state->gates->autoRetrievalInFlight.store(false, std::memory_order_release);
    state->cv.notify_all();

    std::unique_lock<std::mutex> lock(state->mutex);
    const bool completed =
        state->completionCv.wait_for(lock, std::chrono::milliseconds(kWorkerStopTimeoutMs),
                                     [state] { return state->completed; });
    lock.unlock();
    if (completed)
    {
        if (thread_.joinable())
            thread_.join();
        state_.reset();
        return true;
    }

    // Controlled abandonment. The original addon must PinCurrentModule() so machine code
    // stays mapped after Node is gone; a standalone helper instead lets process exit end
    // the thread, which is why this path is simpler but still reported to the caller.
    ++g_abandonedWorkerCount;
    state->abandoned.store(true, std::memory_order_release);
    const ULONGLONG startedAt = state->retrievalStartedAt.load(std::memory_order_acquire);
    const ULONGLONG elapsed = startedAt == 0 ? 0 : GetTickCount64() - startedAt;
    std::fprintf(stderr,
                 "[selection-helper] selection worker stop timed out: stage=%s hwnd=%p elapsed=%llu ms; "
                 "entering controlled abandoned state\n",
                 StageName(state->stage.load()), state->retrievalHwnd.load(),
                 static_cast<unsigned long long>(elapsed));
    if (thread_.joinable())
        thread_.detach();
    state_.reset();
    return false;
}

void RetrievalWorker::ThreadMain(const std::shared_ptr<State> &state)
{
    // UIA client creation, every use, Release(), and CoUninitialize() all occur on this
    // dedicated MTA thread. Raw COM interfaces never cross the thread boundary.
    HRESULT initializationResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comInitialized = SUCCEEDED(initializationResult);
    IUIAutomation *automation = nullptr;
    if (comInitialized)
    {
        // Keep CUIAutomation rather than switching to CUIAutomation8: proxy-provider
        // behavior can differ and would silently change application compatibility.
        initializationResult = CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER,
                                                __uuidof(IUIAutomation), reinterpret_cast<void **>(&automation));
    }
    else
    {
        CoUninitialize();
    }

    RetrievalWorkerSelfTest selfTest;
    selfTest.initializationHr = static_cast<long>(initializationResult);
    if (SUCCEEDED(initializationResult) && automation)
    {
        // Probe beyond CoCreateInstance: prove the automation client can actually talk to
        // the broker (GetRootElement) before self-test claims UIA is usable.
        IUIAutomationElement *root = nullptr;
        const HRESULT probeHr = automation->GetRootElement(&root);
        if (SUCCEEDED(probeHr) && root)
        {
            CONTROLTYPEID rootControlType = 0;
            BSTR rootName = nullptr;
            if (SUCCEEDED(root->get_CurrentControlType(&rootControlType)))
                selfTest.rootControlType = static_cast<long>(rootControlType);
            if (SUCCEEDED(root->get_CurrentName(&rootName)) && rootName)
            {
                selfTest.rootName.assign(rootName, SysStringLen(rootName));
                SysFreeString(rootName);
            }
            selfTest.uiaProbeOk = SUCCEEDED(probeHr);
            root->Release();
        }
        else if (FAILED(probeHr))
        {
            selfTest.error = "GetRootElement failed";
        }
    }
    else
    {
        selfTest.error = "COM/UIA initialization failed";
    }
    selfTest.ready = true;

    {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->initializationResult = selfTest.initializationHr;
        state->selfTest = selfTest;
        state->ready = true;
    }
    state->readyCv.notify_all();

    if (SUCCEEDED(initializationResult) && automation)
    {
        SelectionEngine engine(automation);
        while (true)
        {
            std::unique_ptr<SelectionRequest> request;
            {
                std::unique_lock<std::mutex> lock(state->mutex);
                state->cv.wait(lock,
                               [state]
                               {
                                   return state->stopRequested.load(std::memory_order_acquire) ||
                                          state->pendingRequest != nullptr;
                               });
                if (state->stopRequested.load(std::memory_order_acquire))
                    break;
                request = std::move(state->pendingRequest);
            }
            if (!request)
                continue;

            SelectionWorkerResult result;
            result.sequence = request->sequence;
            result.generation = request->generation;
            result.detectionType = request->detectionType;
            state->retrievalHwnd.store(request->retrievalHwnd, std::memory_order_release);
            state->retrievalStartedAt.store(GetTickCount64(), std::memory_order_release);
            state->stage.store(RetrievalStage::Idle, std::memory_order_release);

            {
                // The guard clears the auto gate on every result, error or stop path
                // before the value-only result is delivered.
                AutoGateGuard gateGuard(state->gates);
                DWORD endingClipboardSequence = request->config.clipboardSequence;
                // Borrowed event-time HWND: validate immediately before use.
                if (!state->stopRequested.load(std::memory_order_acquire) && IsWindow(request->retrievalHwnd))
                {
                    result.found =
                        engine.GetSelectedText(request->retrievalHwnd, result.selection, request->config,
                                               ClipboardLockMode::InterruptibleWait, &state->stopRequested,
                                               &state->stage, &endingClipboardSequence);
                }
                if (request->clipboardSequenceState)
                {
                    // Publish while the auto gate is still held; revision checking keeps
                    // this older result from overwriting a newer mouse-down value.
                    request->clipboardSequenceState->PublishIfUnchanged(endingClipboardSequence,
                                                                        request->clipboardSequenceRevision);
                }

                // UIA coordinates take precedence. Mouse positions only fill the same
                // fallback levels as the historical event path.
                if (result.found && !IsTrimmedEmpty(result.selection.text))
                {
                    switch (request->detectionType)
                    {
                        case SelectionDetectType::Drag:
                            result.selection.mousePosStart = request->mouseDownPos;
                            result.selection.mousePosEnd = request->mouseUpPos;
                            if (result.selection.posLevel == SelectionPositionLevel::None)
                                result.selection.posLevel = SelectionPositionLevel::MouseDual;
                            break;
                        case SelectionDetectType::DoubleClick:
                            result.selection.mousePosStart = request->mouseUpPos;
                            result.selection.mousePosEnd = request->mouseUpPos;
                            if (result.selection.posLevel == SelectionPositionLevel::None)
                                result.selection.posLevel = SelectionPositionLevel::MouseSingle;
                            break;
                        case SelectionDetectType::ShiftClick:
                            result.selection.mousePosStart = request->previousMouseUpPos;
                            result.selection.mousePosEnd = request->mouseUpPos;
                            if (result.selection.posLevel == SelectionPositionLevel::None)
                                result.selection.posLevel = SelectionPositionLevel::MouseDual;
                            break;
                        case SelectionDetectType::None:
                            break;
                    }
                }
            }

            const ULONGLONG elapsed = GetTickCount64() - state->retrievalStartedAt.load(std::memory_order_acquire);
            state->sink(result, state->stage.load(std::memory_order_acquire),
                        static_cast<unsigned long long>(elapsed));
        }
        automation->Release();
    }

    if (comInitialized)
        CoUninitialize();

    {
        std::lock_guard<std::mutex> lock(state->mutex);
        state->completed = true;
    }
    state->completionCv.notify_all();
}

}  // namespace helper
