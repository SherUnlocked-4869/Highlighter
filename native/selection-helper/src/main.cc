/**
 * @file
 * @brief R0-04 prototype: standalone text-selection helper process (no Node-API).
 *
 * Purpose: provide ADR-0002 evidence for D04 ("extract the C++ hook into a standalone
 * helper first, replace the N-API host"). The helper compiles the vendor core verbatim:
 *
 *   vendor/selection-hook/src/windows/core/engine.cc        (UIA -> MSAA -> clipboard)
 *   vendor/selection-hook/src/windows/lib/*.cc              (clipboard/transient/utils)
 *
 * and replaces only the parts that are Node-API bound:
 *   - vendor/core/worker.cc     -> src/retrieval_worker.cc (value-only sink, no TSFN)
 *   - vendor/.../selection_hook.cc (N-API ObjectWrap + JS options + TSFN dispatch)
 *     -> this file: CLI options, WH_MOUSE_LL/WH_KEYBOARD_LL install, gesture state
 *        machine, JSON Lines event sink, heartbeat, self-test.
 *
 * Output contract (prototype only): one JSON object per line on stdout. stderr carries
 * human-readable diagnostics only. See native/selection-helper/README.md.
 *
 * Bounds: no product wiring, no settings, no Electron build changes. Visible automation
 * target windows are opened on the secondary display by test/real-selection.ps1 only.
 */
#define WIN32_LEAN_AND_MEAN 1
#define NOMINMAX 1

#include <windows.h>

#include <ShellScalingApi.h>  // PROCESS_DPI_AWARENESS / SetProcessDpiAwareness
#include <shellapi.h>         // SHQueryUserNotificationState

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "jsonl.h"
#include "retrieval_worker.h"

#include "core/engine.h"
#include "core/types.h"
#include "lib/keyboard.h"
#include "lib/string_pool.h"
#include "lib/utils.h"

namespace
{
// RetrievalWorker is the prototype's value-only replacement for vendor/core/worker.cc.
using helper::RetrievalWorker;
using helper::RetrievalWorkerSelfTest;

// ---------------------------------------------------------------------------------------
// Constants mirrored from vendor/selection-hook/src/windows/selection_hook.cc
// ---------------------------------------------------------------------------------------
constexpr int kDefaultMouseEventQueueSize = 512;
constexpr int kDefaultKeyboardEventQueueSize = 128;
constexpr int kMinDragDistance = 8;
constexpr DWORD kMaxDragTimeMs = 8000;
constexpr int kDoubleClickMaxDistance = 3;
constexpr DWORD kHookReadyTimeoutMs = 5000;
constexpr size_t kMaxEmittedTextBytes = 8192;

const char *kHelperVersion = "r0-04-helper/1.0.0";

enum ExitCode
{
    kExitOk = 0,
    kExitRuntimeError = 1,
    kExitUiaInitFailed = 2,
    kExitHookInstallFailed = 3,
    kExitInvalidArgs = 4,
    kExitSelfTestFailed = 5,
    kExitSelectionTimeout = 6
};

// Same public numeric values as the addon (types.h warns they are API).
enum class MouseButton
{
    None = -1,
    Unknown = 99,
    Left = 0,
    Middle = 1,
    Right = 2,
    Back = 3,
    Forward = 4,
    WheelVertical = 0,
    WheelHorizontal = 1
};

// ---------------------------------------------------------------------------------------
// Command line options
// ---------------------------------------------------------------------------------------
struct Options
{
    bool selfTest = false;
    bool exitAfterSelection = false;
    bool mouseEvents = false;
    bool keyboardEvents = false;
    bool clipboard = false;
    bool enableMouseMove = false;
    int heartbeatMs = 1000;
    int durationMs = 0;  ///< 0 means run until stop; self-test defaults to 1500 ms.
    std::string simulateFailure;  ///< Prototype-only negative-path injection: "uia" | "hook".
};

// ---------------------------------------------------------------------------------------
// Event queue: hook thread -> main thread. Mirrors the TSFN producer/consumer split so
// the low-level hook callback never does blocking I/O (Windows skips slow low-level
// hooks; the addon has the same constraint).
// ---------------------------------------------------------------------------------------
struct MouseEventData
{
    WPARAM event = 0;
    LONG x = 0;
    LONG y = 0;
    DWORD mouseData = 0;
    DWORD timestampMs = 0;
    DWORD buttonMask = 0;
    DWORD modifierMask = 0;
    HCURSOR cursor = nullptr;
    HWND window = nullptr;
    RECT windowRect = {0, 0, 0, 0};
    DWORD clipboardSequence = 0;
};

struct KeyboardEventData
{
    WPARAM event = 0;
    DWORD vkCode = 0;
    DWORD scanCode = 0;
    DWORD flags = 0;
};

class EventQueue
{
  public:
    bool PushMouse(std::unique_ptr<MouseEventData> event)
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (mouseEvents_.size() >= static_cast<size_t>(kDefaultMouseEventQueueSize))
            {
                ++droppedMouse_;
                return false;
            }
            mouseEvents_.push_back(std::move(event));
        }
        return true;
    }

    bool PushKeyboard(std::unique_ptr<KeyboardEventData> event)
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (keyboardEvents_.size() >= static_cast<size_t>(kDefaultKeyboardEventQueueSize))
            {
                ++droppedKeyboard_;
                return false;
            }
            keyboardEvents_.push_back(std::move(event));
        }
        return true;
    }

    void DrainMouse(std::deque<std::unique_ptr<MouseEventData>> &target)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        target.swap(mouseEvents_);
    }

    void DrainKeyboard(std::deque<std::unique_ptr<KeyboardEventData>> &target)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        target.swap(keyboardEvents_);
    }

    unsigned long long droppedMouse() const { return droppedMouse_; }
    unsigned long long droppedKeyboard() const { return droppedKeyboard_; }

  private:
    mutable std::mutex mutex_;
    std::deque<std::unique_ptr<MouseEventData>> mouseEvents_;
    std::deque<std::unique_ptr<KeyboardEventData>> keyboardEvents_;
    unsigned long long droppedMouse_ = 0;
    unsigned long long droppedKeyboard_ = 0;
};

// ---------------------------------------------------------------------------------------
// Gesture tracking state (main thread only; mirrors SelectionHook instance members).
// ---------------------------------------------------------------------------------------
struct GestureState
{
    POINT lastLastMouseUpPos = {0, 0};
    POINT lastMouseUpPos = {0, 0};
    DWORD lastMouseUpTime = 0;
    POINT lastMouseDownPos = {0, 0};
    DWORD lastMouseDownTime = 0;
    bool isLastValidClick = false;
    HWND lastWindowHandler = nullptr;
    RECT lastWindowRect = {0, 0, 0, 0};
    HCURSOR mouseDownCursor = nullptr;
    HCURSOR mouseUpCursor = nullptr;
};

// ---------------------------------------------------------------------------------------
// Globals: the prototype intentionally supports one helper instance per process, like
// the addon's static currentInstance.
// ---------------------------------------------------------------------------------------
Options g_options;
EventQueue g_queue;
GestureState g_gesture;

HANDLE g_wakeEvent = nullptr;      ///< Auto-reset: data ready or stop requested.
HANDLE g_hookReadyEvent = nullptr; ///< Manual-reset: hook thread finished installing.
HANDLE g_hookStopEvent = nullptr;  ///< Manual-reset: stop the hook message loop.

std::atomic<bool> g_stopRequested{false};
std::atomic<bool> g_hookInstalled{false};
std::atomic<bool> g_mouseHookOk{false};
std::atomic<bool> g_keyboardHookOk{false};
std::atomic<DWORD> g_hookInstallError{0};
std::atomic<bool> g_selectionSeen{false};

std::shared_ptr<RetrievalGates> g_gates;
std::shared_ptr<ClipboardSequenceState> g_clipboardSequenceState;
RetrievalWorker *g_worker = nullptr;

// Counters for the heartbeat line.
std::atomic<unsigned long long> g_mouseEventsQueued{0};
std::atomic<unsigned long long> g_keyboardEventsQueued{0};
std::atomic<unsigned long long> g_autoRetrievals{0};
std::atomic<unsigned long long> g_retrievalsCompleted{0};
std::atomic<unsigned long long> g_selectionsFound{0};
std::atomic<unsigned long long> g_sequence{0};
std::atomic<DWORD> g_lastMouseEventTick{0};
std::atomic<DWORD> g_lastKeyEventTick{0};
std::atomic<HWND> g_retrievalHwnd{nullptr};
std::atomic<DWORD> g_retrievalPid{0};

DWORD g_doubleClickTimeMs = 500;

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------
const char *DetectionName(SelectionDetectType type)
{
    switch (type)
    {
        case SelectionDetectType::None:
            return "none";
        case SelectionDetectType::Drag:
            return "drag";
        case SelectionDetectType::DoubleClick:
            return "double-click";
        case SelectionDetectType::ShiftClick:
            return "shift-click";
    }
    return "unknown";
}

const char *MethodName(SelectionMethod method)
{
    switch (method)
    {
        case SelectionMethod::None:
            return "none";
        case SelectionMethod::UIA:
            return "uia";
        case SelectionMethod::FocusControl:
            return "focus-control(deprecated)";
        case SelectionMethod::Accessible:
            return "msaa";
        case SelectionMethod::Clipboard:
            return "clipboard";
    }
    return "unknown";
}

const char *PositionLevelName(SelectionPositionLevel level)
{
    switch (level)
    {
        case SelectionPositionLevel::None:
            return "none";
        case SelectionPositionLevel::MouseSingle:
            return "mouse-single";
        case SelectionPositionLevel::MouseDual:
            return "mouse-dual";
        case SelectionPositionLevel::Full:
            return "full";
        case SelectionPositionLevel::Detailed:
            return "detailed";
    }
    return "unknown";
}

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

std::string HexValue(long long value)
{
    char buffer[24] = {};
    std::snprintf(buffer, sizeof(buffer), "0x%llx", static_cast<unsigned long long>(value));
    return std::string(buffer);
}

std::string TruncateUtf8(const std::string &text, size_t maxBytes, bool &truncated)
{
    if (text.size() <= maxBytes)
    {
        truncated = false;
        return text;
    }
    size_t cut = maxBytes;
    while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0) == 0x80)
        --cut;
    truncated = true;
    return text.substr(0, cut);
}

void EmitError(const char *stage, int exitCode, const std::string &message, DWORD win32Error = 0, long hr = 0)
{
    helper::JsonLine line;
    line.Envelope("error").Str("stage", stage).Int("exitCode", exitCode).Str("message", message);
    if (win32Error != 0)
        line.Int("win32Error", static_cast<long long>(win32Error)).Str("win32ErrorHex", HexValue(win32Error));
    if (hr != 0)
        line.Str("hr", HexValue(hr));
    helper::Emit(line);
    std::fprintf(stderr, "[selection-helper] error stage=%s exit=%d message=%s (win32=%lu)\n", stage, exitCode,
                 message.c_str(), win32Error);
}

void EmitStatus(const char *status)
{
    helper::JsonLine line;
    line.Envelope("status").Str("status", status);
    helper::Emit(line);
}

/** @brief Same notification-state gate as the addon (cached for 10 s). */
bool ShouldProcessGetSelection()
{
    static bool lastResult = true;
    static DWORD lastCheckTime = 0;

    if (GetTickCount() - lastCheckTime < 10000)
        return lastResult;

    QUERY_USER_NOTIFICATION_STATE state{};
    const HRESULT hr = SHQueryUserNotificationState(&state);
    lastCheckTime = GetTickCount();
    if (FAILED(hr))
    {
        lastResult = true;  // Cannot determine state -> keep the historical permissive default.
        return lastResult;
    }
    // Same two suppression states as the addon: D3D full screen and presentation mode.
    lastResult = state != QUNS_RUNNING_D3D_FULL_SCREEN && state != QUNS_PRESENTATION_MODE;
    return lastResult;
}

/** @brief Mirror of SelectionHook::EnableDpiAwareness (per-monitor v1 on Win8.1+). */
void EnableDpiAwareness()
{
    typedef HRESULT(WINAPI * SetProcessDpiAwarenessFn)(PROCESS_DPI_AWARENESS);
    HMODULE shcore = LoadLibraryA("Shcore.dll");
    if (shcore)
    {
        auto setProcessDpiAwareness = reinterpret_cast<SetProcessDpiAwarenessFn>(
            GetProcAddress(shcore, "SetProcessDpiAwareness"));
        if (setProcessDpiAwareness != nullptr)
        {
            const HRESULT hr = setProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
            helper::JsonLine line;
            line.Envelope("status").Str("status", "dpi-awareness").Str("mode", "per-monitor-v1").Str("hr", HexValue(hr));
            helper::Emit(line);
        }
        else
        {
            SetProcessDPIAware();
        }
        FreeLibrary(shcore);
    }
    else
    {
        SetProcessDPIAware();
    }
}

SelectionConfigSnapshot BuildSelectionConfig()
{
    // Value-only snapshot: the worker must never read mutable dispatcher state.
    SelectionConfigSnapshot config;
    config.clipboardEnabled = g_options.clipboard;
    config.triggeredByUser = false;
    config.clipboardFilterMode = FilterMode::Default;
    config.globalFilterMode = FilterMode::Default;
    config.mouseDownCursor = g_gesture.mouseDownCursor;
    config.mouseUpCursor = g_gesture.mouseUpCursor;
    config.clipboardSequence = g_clipboardSequenceState->Load().value;
    return config;
}

bool EnqueueAutomaticSelection(HWND hwnd, SelectionDetectType detectionType)
{
    if (!hwnd || g_stopRequested.load(std::memory_order_acquire) || !g_worker)
        return false;

    // Preserve the addon's one-retrieval-at-a-time behavior: new low-level events remain
    // suppressed while this gate is set, so no stale selection backlog is built.
    bool expected = false;
    if (!g_gates->autoRetrievalInFlight.compare_exchange_strong(expected, true, std::memory_order_acq_rel))
        return false;

    SelectionRequest request;
    request.sequence = g_sequence.fetch_add(1, std::memory_order_acq_rel) + 1;
    request.generation = 1;  // Single helper session; the addon bumps this on restart.
    request.retrievalHwnd = hwnd;
    request.detectionType = detectionType;
    request.mouseDownPos = g_gesture.lastMouseDownPos;
    request.mouseUpPos = g_gesture.lastMouseUpPos;
    request.previousMouseUpPos = g_gesture.lastLastMouseUpPos;
    request.config = BuildSelectionConfig();

    const ClipboardSequenceSnapshot clipboardSequence = g_clipboardSequenceState->Load();
    request.config.clipboardSequence = clipboardSequence.value;
    request.clipboardSequenceState = g_clipboardSequenceState;
    request.clipboardSequenceRevision = clipboardSequence.revision;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    g_retrievalHwnd.store(hwnd, std::memory_order_release);
    g_retrievalPid.store(pid, std::memory_order_release);

    if (!g_worker->Enqueue(std::move(request)))
    {
        g_gates->autoRetrievalInFlight.store(false, std::memory_order_release);
        return false;
    }
    g_autoRetrievals.fetch_add(1, std::memory_order_relaxed);
    return true;
}

// ---------------------------------------------------------------------------------------
// Result sink (retrieval worker thread): JSON Lines only, no dispatch back to a UI loop.
// ---------------------------------------------------------------------------------------
void OnRetrievalResult(const SelectionWorkerResult &result, RetrievalStage stage, unsigned long long elapsedMs)
{
    const TextSelectionInfo &selection = result.selection;
    const bool found = result.found && !IsTrimmedEmpty(selection.text);
    g_retrievalsCompleted.fetch_add(1, std::memory_order_relaxed);
    if (found)
        g_selectionsFound.fetch_add(1, std::memory_order_relaxed);

    bool truncated = false;
    const std::string text = TruncateUtf8(helper::WideToUtf8(selection.text), kMaxEmittedTextBytes, truncated);
    const HWND hwnd = g_retrievalHwnd.load(std::memory_order_acquire);

    helper::JsonLine line;
    line.Envelope("text-selection")
        .UInt("sequence", result.sequence)
        .Str("detection", DetectionName(result.detectionType))
        .Bool("found", found)
        .UInt("textLength", static_cast<unsigned long long>(selection.text.size()))
        .Str("text", text)
        .Bool("textTruncated", truncated)
        .UInt("sourcePid", g_retrievalPid.load(std::memory_order_acquire))
        .Hex("sourceHwnd", reinterpret_cast<unsigned long long>(hwnd))
        .Str("program", helper::WideToUtf8(selection.programName))
        .Int("method", static_cast<int>(selection.method))
        .Str("methodName", MethodName(selection.method))
        .Int("positionLevel", static_cast<int>(selection.posLevel))
        .Str("positionLevelName", PositionLevelName(selection.posLevel))
        .Point("startTop", selection.startTop)
        .Point("startBottom", selection.startBottom)
        .Point("endTop", selection.endTop)
        .Point("endBottom", selection.endBottom)
        .Point("mouseStart", selection.mousePosStart)
        .Point("mouseEnd", selection.mousePosEnd)
        .Str("stage", StageName(stage))
        .UInt("retrievalElapsedMs", elapsedMs);
    helper::Emit(line);

    if (found && g_options.exitAfterSelection && !g_selectionSeen.exchange(true))
    {
        g_stopRequested.store(true, std::memory_order_release);
        if (g_wakeEvent)
            SetEvent(g_wakeEvent);
    }
}

std::shared_ptr<RetrievalGates> MakeGates()
{
    return std::make_shared<RetrievalGates>();
}

// ---------------------------------------------------------------------------------------
// Mouse gesture state machine: port of SelectionHook::ProcessMouseEvent minus N-API.
// MUST stay behaviorally aligned with the addon; see upstream comments referenced below.
// ---------------------------------------------------------------------------------------
void EmitMouseEvent(const char *action, POINT position, MouseButton button, int flag)
{
    helper::JsonLine line;
    line.Envelope("mouse-event").Str("action", action).Point("position", position).Int("button", static_cast<int>(button)).Int(
        "flag", flag);
    helper::Emit(line);
}

void ProcessMouseEvent(std::unique_ptr<MouseEventData> event)
{
    if (!ShouldProcessGetSelection())
        return;

    const WPARAM message = event->event;
    const DWORD eventTime = event->timestampMs;
    const DWORD eventButtonMask = event->buttonMask;
    const DWORD eventModifierMask = event->modifierMask;
    const HCURSOR eventCursor = event->cursor;
    const HWND eventWindow = event->window;
    const RECT eventWindowRect = event->windowRect;
    const DWORD eventClipboardSequence = event->clipboardSequence;
    const POINT currentPos = {event->x, event->y};
    const DWORD mouseData = event->mouseData;

    POINT position = currentPos;
    bool shouldDetectSelection = false;
    auto detectionType = SelectionDetectType::None;
    const char *mouseType = "";
    MouseButton mouseButton = MouseButton::None;
    int mouseFlag = 0;

    switch (message)
    {
        case WM_LBUTTONDOWN:
            mouseType = "mouse-down";
            mouseButton = MouseButton::Left;
            g_gesture.lastMouseDownTime = eventTime;
            g_gesture.lastMouseDownPos = currentPos;
            g_gesture.lastWindowHandler = eventWindow;
            g_gesture.lastWindowRect = eventWindowRect;
            if (g_options.clipboard)
                g_gesture.mouseDownCursor = eventCursor;
            g_clipboardSequenceState->Store(eventClipboardSequence);
            break;

        case WM_LBUTTONUP:
        {
            mouseType = "mouse-up";
            mouseButton = MouseButton::Left;
            // Gesture timing MUST use the event timestamp, not the drain time.
            const DWORD currentTime = eventTime;
            const int dx = currentPos.x - g_gesture.lastMouseDownPos.x;
            const int dy = currentPos.y - g_gesture.lastMouseDownPos.y;
            const double distance = std::sqrt(static_cast<double>(dx * dx + dy * dy));
            const bool isCurrentValidClick =
                (currentTime - g_gesture.lastMouseDownTime) <= g_doubleClickTimeMs;

            if ((currentTime - g_gesture.lastMouseDownTime) > kMaxDragTimeMs)
            {
                shouldDetectSelection = false;
            }
            else if (distance >= kMinDragDistance)
            {
                if (eventWindow && eventWindow == g_gesture.lastWindowHandler &&
                    !HasWindowMoved(eventWindowRect, g_gesture.lastWindowRect))
                {
                    // Drag selection.
                    shouldDetectSelection = true;
                    detectionType = SelectionDetectType::Drag;
                }
            }
            else if (g_gesture.isLastValidClick && isCurrentValidClick && distance <= kDoubleClickMaxDistance)
            {
                const int secondDx = currentPos.x - g_gesture.lastMouseUpPos.x;
                const int secondDy = currentPos.y - g_gesture.lastMouseUpPos.y;
                const double secondDistance =
                    std::sqrt(static_cast<double>(secondDx * secondDx + secondDy * secondDy));
                if (secondDistance <= kDoubleClickMaxDistance &&
                    (g_gesture.lastMouseDownTime - g_gesture.lastMouseUpTime) <= g_doubleClickTimeMs)
                {
                    if (eventWindow && eventWindow == g_gesture.lastWindowHandler &&
                        !HasWindowMoved(eventWindowRect, g_gesture.lastWindowRect))
                    {
                        // Double-click selection.
                        shouldDetectSelection = true;
                        detectionType = SelectionDetectType::DoubleClick;
                    }
                }
            }

            // Shift-click selection uses the event-time modifier snapshot.
            if (!shouldDetectSelection)
            {
                const bool isShiftPressed = (eventModifierMask & 0x01) != 0;
                const bool isCtrlPressed = (eventModifierMask & 0x02) != 0;
                const bool isAltPressed = (eventModifierMask & 0x04) != 0;
                if (isShiftPressed && !isCtrlPressed && !isAltPressed)
                {
                    shouldDetectSelection = true;
                    detectionType = SelectionDetectType::ShiftClick;
                }
            }

            if (shouldDetectSelection && g_options.clipboard)
                g_gesture.mouseUpCursor = eventCursor;

            g_gesture.isLastValidClick = isCurrentValidClick;
            g_gesture.lastLastMouseUpPos = g_gesture.lastMouseUpPos;
            g_gesture.lastMouseUpTime = currentTime;
            g_gesture.lastMouseUpPos = currentPos;
            break;
        }

        case WM_MOUSEMOVE:
            mouseType = "mouse-move";
            if (eventButtonMask & 0x01)
                mouseButton = MouseButton::Left;
            else if (eventButtonMask & 0x02)
                mouseButton = MouseButton::Right;
            else if (eventButtonMask & 0x04)
                mouseButton = MouseButton::Middle;
            else if (eventButtonMask & 0x08)
                mouseButton = MouseButton::Back;
            else if (eventButtonMask & 0x10)
                mouseButton = MouseButton::Forward;
            break;

        case WM_RBUTTONDOWN:
            mouseType = "mouse-down";
            mouseButton = MouseButton::Right;
            break;

        case WM_RBUTTONUP:
            mouseType = "mouse-up";
            mouseButton = MouseButton::Right;
            break;

        case WM_MBUTTONDOWN:
            mouseType = "mouse-down";
            mouseButton = MouseButton::Middle;
            break;

        case WM_MBUTTONUP:
            mouseType = "mouse-up";
            mouseButton = MouseButton::Middle;
            break;

        case WM_XBUTTONDOWN:
        case WM_XBUTTONUP:
            mouseType = message == WM_XBUTTONUP ? "mouse-up" : "mouse-down";
            mouseButton = HIWORD(mouseData) == XBUTTON1 ? MouseButton::Back : MouseButton::Forward;
            break;

        case WM_MOUSEWHEEL:
        case WM_MOUSEHWHEEL:
            mouseType = "mouse-wheel";
            mouseButton = message == WM_MOUSEWHEEL ? MouseButton::WheelVertical : MouseButton::WheelHorizontal;
            mouseFlag = GET_WHEEL_DELTA_WPARAM(mouseData) > 0 ? 1 : -1;
            break;

        default:
            mouseType = "unknown";
            mouseButton = MouseButton::Unknown;
            break;
    }

    if (shouldDetectSelection)
    {
        // Same call site as the addon: the foreground window, not WindowFromPoint.
        const HWND hwnd = GetForegroundWindow();
        if (hwnd)
            EnqueueAutomaticSelection(hwnd, detectionType);
    }

    if (g_options.mouseEvents && mouseType[0] != '\0')
        EmitMouseEvent(mouseType, position, mouseButton, mouseFlag);
}

void ProcessKeyboardEvent(std::unique_ptr<KeyboardEventData> event)
{
    if (!ShouldProcessGetSelection())
        return;
    if (!g_options.keyboardEvents)
        return;

    const char *eventType = "";
    switch (event->event)
    {
        case WM_KEYDOWN:
        case WM_SYSKEYDOWN:
            eventType = "key-down";
            break;
        case WM_KEYUP:
        case WM_SYSKEYUP:
            eventType = "key-up";
            break;
        default:
            return;
    }
    const std::string uniKey = convertKeyCodeToUniKey(event->vkCode, event->scanCode, event->flags);
    helper::JsonLine line;
    line.Envelope("keyboard-event")
        .Str("action", eventType)
        .Str("uniKey", uniKey)
        .UInt("vkCode", event->vkCode)
        .UInt("scanCode", event->scanCode)
        .UInt("flags", event->flags);
    helper::Emit(line);
}

void DrainAndDispatch()
{
    std::deque<std::unique_ptr<MouseEventData>> mouseEvents;
    std::deque<std::unique_ptr<KeyboardEventData>> keyboardEvents;
    g_queue.DrainMouse(mouseEvents);
    g_queue.DrainKeyboard(keyboardEvents);
    for (auto &event : keyboardEvents)
        ProcessKeyboardEvent(std::move(event));
    for (auto &event : mouseEvents)
        ProcessMouseEvent(std::move(event));
}

// ---------------------------------------------------------------------------------------
// Low-level hooks: same install thread / message pump shape as the addon.
// ---------------------------------------------------------------------------------------
std::atomic<HHOOK> g_mouseHook{nullptr};
std::atomic<HHOOK> g_keyboardHook{nullptr};

LRESULT CALLBACK MouseHookCallback(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode == HC_ACTION)
    {
        auto *mouseInfo = reinterpret_cast<MSLLHOOKSTRUCT *>(lParam);

        // Update the button bitmap BEFORE any filtering so state survives skipped events.
        static std::atomic<DWORD> buttonPressingFlag{0};
        switch (wParam)
        {
            case WM_LBUTTONDOWN:
                buttonPressingFlag.fetch_or(0x01u);
                break;
            case WM_LBUTTONUP:
                buttonPressingFlag.fetch_and(~0x01u);
                break;
            case WM_RBUTTONDOWN:
                buttonPressingFlag.fetch_or(0x02u);
                break;
            case WM_RBUTTONUP:
                buttonPressingFlag.fetch_and(~0x02u);
                break;
            case WM_MBUTTONDOWN:
                buttonPressingFlag.fetch_or(0x04u);
                break;
            case WM_MBUTTONUP:
                buttonPressingFlag.fetch_and(~0x04u);
                break;
            case WM_XBUTTONDOWN:
                buttonPressingFlag.fetch_or(HIWORD(mouseInfo->mouseData) == XBUTTON1 ? 0x08u : 0x10u);
                break;
            case WM_XBUTTONUP:
                buttonPressingFlag.fetch_and(~(HIWORD(mouseInfo->mouseData) == XBUTTON1 ? 0x08u : 0x10u));
                break;
            default:
                break;
        }

        const bool retrievalInFlight = g_gates && g_gates->IsAnyRetrievalInFlight();
        if (!retrievalInFlight && !(wParam == WM_MOUSEMOVE && !g_options.enableMouseMove))
        {
            HCURSOR cursor = nullptr;
            HWND window = nullptr;
            RECT windowRect = {0, 0, 0, 0};
            DWORD clipboardSequence = 0;
            if (wParam == WM_LBUTTONDOWN || wParam == WM_LBUTTONUP)
            {
                CURSORINFO cursorInfo = {sizeof(CURSORINFO)};
                if (GetCursorInfo(&cursorInfo))
                    cursor = cursorInfo.hCursor;
                window = WindowFromPoint(mouseInfo->pt);
                if (!window)
                    window = GetForegroundWindow();
                if (window && !GetWindowRect(window, &windowRect))
                {
                    window = nullptr;
                    windowRect = {0, 0, 0, 0};
                }
                if (wParam == WM_LBUTTONDOWN)
                    clipboardSequence = GetClipboardSequenceNumber();
            }

            auto event = std::make_unique<MouseEventData>();
            event->event = wParam;
            event->x = mouseInfo->pt.x;
            event->y = mouseInfo->pt.y;
            event->mouseData = mouseInfo->mouseData;
            event->timestampMs = mouseInfo->time;
            event->buttonMask = buttonPressingFlag.load();
            DWORD modifierMask = 0;
            if (GetAsyncKeyState(VK_SHIFT) & 0x8000)
                modifierMask |= 0x01;
            if (GetAsyncKeyState(VK_CONTROL) & 0x8000)
                modifierMask |= 0x02;
            if (GetAsyncKeyState(VK_MENU) & 0x8000)
                modifierMask |= 0x04;
            event->modifierMask = modifierMask;
            event->cursor = cursor;
            event->window = window;
            event->windowRect = windowRect;
            event->clipboardSequence = clipboardSequence;

            if (g_queue.PushMouse(std::move(event)))
            {
                g_mouseEventsQueued.fetch_add(1, std::memory_order_relaxed);
                g_lastMouseEventTick.store(GetTickCount(), std::memory_order_relaxed);
                if (g_wakeEvent)
                    SetEvent(g_wakeEvent);
            }
        }
    }
    return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

LRESULT CALLBACK KeyboardHookCallback(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode == HC_ACTION)
    {
        auto *keyInfo = reinterpret_cast<KBDLLHOOKSTRUCT *>(lParam);
        // Keep the process-wide input serial used by the clipboard transaction guard.
        highlighter::ObserveInput(*keyInfo, wParam);
        g_lastKeyEventTick.store(GetTickCount(), std::memory_order_relaxed);
        if (g_gates && !g_gates->IsAnyRetrievalInFlight() && g_options.keyboardEvents)
        {
            auto event = std::make_unique<KeyboardEventData>();
            event->event = wParam;
            event->vkCode = keyInfo->vkCode;
            event->scanCode = keyInfo->scanCode;
            event->flags = keyInfo->flags;
            if (g_queue.PushKeyboard(std::move(event)))
            {
                g_keyboardEventsQueued.fetch_add(1, std::memory_order_relaxed);
                if (g_wakeEvent)
                    SetEvent(g_wakeEvent);
            }
        }
    }
    return CallNextHookEx(nullptr, nCode, wParam, lParam);
}

void HookThreadProc()
{
    MSG message = {};
    // Force Windows to create this thread's message queue before reporting ready.
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);

    const HHOOK mouseHook =
        SetWindowsHookExW(WH_MOUSE_LL, MouseHookCallback, nullptr, 0);
    const DWORD mouseError = mouseHook ? 0 : GetLastError();
    const HHOOK keyboardHook =
        SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHookCallback, nullptr, 0);
    const DWORD keyboardError = keyboardHook ? 0 : GetLastError();

    g_mouseHook.store(mouseHook);
    g_keyboardHook.store(keyboardHook);
    g_mouseHookOk.store(mouseHook != nullptr);
    g_keyboardHookOk.store(keyboardHook != nullptr);
    g_hookInstallError.store(mouseError != 0 ? mouseError : keyboardError);
    g_hookInstalled.store(mouseHook != nullptr && keyboardHook != nullptr);
    if (g_hookReadyEvent)
        SetEvent(g_hookReadyEvent);

    if (!mouseHook || !keyboardHook)
    {
        std::fprintf(stderr, "[selection-helper] hook install failed: mouse=%p (err=%lu) keyboard=%p (err=%lu)\n",
                     mouseHook, mouseError, keyboardHook, keyboardError);
    }

    DWORD waitFlags = MWMO_INPUTAVAILABLE;
    while (true)
    {
        HANDLE stopEvent = g_hookStopEvent;
        const DWORD waitResult = MsgWaitForMultipleObjectsEx(1, &stopEvent, INFINITE, QS_ALLINPUT, waitFlags);
        if (waitResult == WAIT_OBJECT_0)
            break;
        if (waitResult == WAIT_OBJECT_0 + 1)
        {
            const BOOL foundMessage = PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE);
            if (foundMessage && message.message == WM_QUIT)
                break;
            waitFlags = foundMessage ? MWMO_INPUTAVAILABLE : 0;
            continue;
        }
        if (waitResult == WAIT_FAILED)
            std::fprintf(stderr, "[selection-helper] MsgWaitForMultipleObjectsEx failed: %lu\n", GetLastError());
        break;
    }

    if (mouseHook)
        UnhookWindowsHookEx(mouseHook);
    if (keyboardHook)
        UnhookWindowsHookEx(keyboardHook);
    g_mouseHook.store(nullptr);
    g_keyboardHook.store(nullptr);
}

// ---------------------------------------------------------------------------------------
// Heartbeat and environment probe
// ---------------------------------------------------------------------------------------
void EmitHeartbeat(unsigned long long uptimeMs, DWORD lastMouseTick, DWORD lastKeyTick)
{
    const DWORD now = GetTickCount();
    helper::JsonLine line;
    line.Envelope("heartbeat")
        .UInt("elapsedMs", uptimeMs)
        .Bool("hookRunning", g_mouseHook.load() != nullptr && g_keyboardHook.load() != nullptr)
        .UInt("autoRetrievals", g_autoRetrievals.load(std::memory_order_relaxed))
        .UInt("retrievalsCompleted", g_retrievalsCompleted.load(std::memory_order_relaxed))
        .UInt("selectionsFound", g_selectionsFound.load(std::memory_order_relaxed))
        .UInt("mouseEventsQueued", g_mouseEventsQueued.load(std::memory_order_relaxed))
        .UInt("mouseEventsDropped", g_queue.droppedMouse())
        .UInt("keyboardEventsQueued", g_keyboardEventsQueued.load(std::memory_order_relaxed))
        .Int("lastMouseEventAgoMs", lastMouseTick == 0 ? -1 : static_cast<long long>(now - lastMouseTick))
        .Int("lastKeyEventAgoMs", lastKeyTick == 0 ? -1 : static_cast<long long>(now - lastKeyTick));
    helper::Emit(line);
}

void EmitEnvironmentProbe()
{
    const HWND foreground = GetForegroundWindow();
    DWORD foregroundPid = 0;
    if (foreground)
        GetWindowThreadProcessId(foreground, &foregroundPid);
    std::wstring programName;
    if (foreground)
        GetProgramNameFromHwnd(foreground, programName);

    helper::JsonLine line;
    line.Envelope("probe")
        .Str("name", "environment")
        .Hex("foregroundHwnd", reinterpret_cast<unsigned long long>(foreground))
        .UInt("foregroundPid", foregroundPid)
        .Str("foregroundProgram", helper::WideToUtf8(programName))
        .Int("virtualScreenX", GetSystemMetrics(SM_XVIRTUALSCREEN))
        .Int("virtualScreenY", GetSystemMetrics(SM_YVIRTUALSCREEN))
        .Int("virtualScreenWidth", GetSystemMetrics(SM_CXVIRTUALSCREEN))
        .Int("virtualScreenHeight", GetSystemMetrics(SM_CYVIRTUALSCREEN))
        .UInt("monitorCount", static_cast<unsigned long long>(GetSystemMetrics(SM_CMONITORS)))
        .UInt("doubleClickTimeMs", g_doubleClickTimeMs)
        .Str("dpiAwareness", "per-monitor-v1");
    helper::Emit(line);
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------
void PrintUsage()
{
    std::printf(
        "selection-helper (R0-04 prototype, no Node-API)\n"
        "\n"
        "Usage: selection-helper [options]\n"
        "\n"
        "Options:\n"
        "  --self-test              Validate UIA worker + both low-level hooks, then exit.\n"
        "  --duration <seconds>     Run for N seconds (integer or decimal) instead of forever.\n"
        "  --duration-ms <ms>       Run for N milliseconds (used by automation).\n"
        "  --exit-after-selection   Exit 0 after the first text selection, 6 on timeout.\n"
        "  --heartbeat-ms <ms>      Heartbeat interval (default 1000, 0 disables).\n"
        "  --clipboard              Enable the clipboard fallback (default off = product host default).\n"
        "  --mouse-events           Emit mouse-event lines (high volume).\n"
        "  --keyboard-events        Emit keyboard-event lines (high volume).\n"
        "  --enable-mouse-move      Queue WM_MOUSEMOVE events (addon option, default off).\n"
        "  --simulate-failure <x>   Prototype-only negative-path injection: uia | hook.\n"
        "  --help                   This text.\n"
        "\n"
        "Exit codes: 0 ok, 1 runtime error, 2 UIA/COM init failed, 3 hook install failed,\n"
        "            4 invalid arguments, 5 self-test failed, 6 selection timeout.\n");
}

bool ParseArgs(int argc, char **argv, Options &options, bool &helpRequested)
{
    auto parseNumber = [](const char *text, long long &value) -> bool
    {
        if (!text || *text == '\0')
            return false;
        char *end = nullptr;
        const long long parsed = std::strtoll(text, &end, 10);
        if (end == text || *end != '\0')
            return false;
        value = parsed;
        return true;
    };

    for (int i = 1; i < argc; ++i)
    {
        const std::string argument = argv[i];
        auto takeValue = [&](std::string &value) -> bool
        {
            if (i + 1 >= argc)
                return false;
            value = argv[++i];
            return true;
        };

        if (argument == "--help" || argument == "-h")
        {
            PrintUsage();
            helpRequested = true;
            return false;
        }
        if (argument == "--self-test")
        {
            options.selfTest = true;
        }
        else if (argument == "--exit-after-selection")
        {
            options.exitAfterSelection = true;
        }
        else if (argument == "--clipboard")
        {
            options.clipboard = true;
        }
        else if (argument == "--mouse-events")
        {
            options.mouseEvents = true;
        }
        else if (argument == "--keyboard-events")
        {
            options.keyboardEvents = true;
        }
        else if (argument == "--enable-mouse-move")
        {
            options.enableMouseMove = true;
        }
        else if (argument.rfind("--duration-ms=", 0) == 0 || argument == "--duration-ms")
        {
            std::string value = argument.rfind("--duration-ms=", 0) == 0 ? argument.substr(14) : std::string();
            if (value.empty() && !takeValue(value))
                return false;
            long long parsed = 0;
            if (!parseNumber(value.c_str(), parsed) || parsed < 0)
                return false;
            options.durationMs = static_cast<int>(parsed);
        }
        else if (argument.rfind("--duration=", 0) == 0 || argument == "--duration")
        {
            std::string value = argument.rfind("--duration=", 0) == 0 ? argument.substr(11) : std::string();
            if (value.empty() && !takeValue(value))
                return false;
            char *end = nullptr;
            const double seconds = std::strtod(value.c_str(), &end);
            if (end == value.c_str() || *end != '\0' || seconds < 0 || seconds > 86400)
                return false;
            options.durationMs = static_cast<int>(seconds * 1000.0);
        }
        else if (argument.rfind("--heartbeat-ms=", 0) == 0 || argument == "--heartbeat-ms")
        {
            std::string value = argument.rfind("--heartbeat-ms=", 0) == 0 ? argument.substr(15) : std::string();
            if (value.empty() && !takeValue(value))
                return false;
            long long parsed = 0;
            if (!parseNumber(value.c_str(), parsed) || parsed < 0)
                return false;
            options.heartbeatMs = static_cast<int>(parsed);
        }
        else if (argument.rfind("--simulate-failure=", 0) == 0 || argument == "--simulate-failure")
        {
            std::string value = argument.rfind("--simulate-failure=", 0) == 0 ? argument.substr(19) : std::string();
            if (value.empty() && !takeValue(value))
                return false;
            if (value != "uia" && value != "hook")
                return false;
            options.simulateFailure = value;
        }
        else
        {
            std::fprintf(stderr, "[selection-helper] unknown argument: %s\n", argument.c_str());
            return false;
        }
    }
    return true;
}

BOOL WINAPI ConsoleControlHandler(DWORD controlType)
{
    if (controlType == CTRL_C_EVENT || controlType == CTRL_BREAK_EVENT || controlType == CTRL_CLOSE_EVENT ||
        controlType == CTRL_LOGOFF_EVENT || controlType == CTRL_SHUTDOWN_EVENT)
    {
        g_stopRequested.store(true, std::memory_order_release);
        if (g_wakeEvent)
            SetEvent(g_wakeEvent);
        return TRUE;
    }
    return FALSE;
}

// ---------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------
int RunLoop(DWORD durationMs, unsigned long long &observedUptime)
{
    const ULONGLONG startTick = GetTickCount64();
    const ULONGLONG deadline = durationMs == 0 ? 0 : startTick + durationMs;
    ULONGLONG lastHeartbeat = startTick;
    observedUptime = 0;

    while (!g_stopRequested.load(std::memory_order_acquire))
    {
        DWORD waitMs = 200;
        const ULONGLONG now = GetTickCount64();
        if (g_options.heartbeatMs > 0)
        {
            const ULONGLONG sinceHeartbeat = now - lastHeartbeat;
            const ULONGLONG remaining = static_cast<ULONGLONG>(g_options.heartbeatMs) > sinceHeartbeat
                                             ? static_cast<ULONGLONG>(g_options.heartbeatMs) - sinceHeartbeat
                                             : 0;
            waitMs = static_cast<DWORD>(std::min<ULONGLONG>(waitMs, remaining + 1));
        }
        if (deadline != 0)
        {
            if (now >= deadline)
                break;
            waitMs = static_cast<DWORD>(std::min<ULONGLONG>(waitMs, deadline - now));
        }
        if (waitMs > 0)
            WaitForSingleObject(g_wakeEvent, waitMs);

        DrainAndDispatch();

        const ULONGLONG afterDrain = GetTickCount64();
        if (g_options.heartbeatMs > 0 && afterDrain - lastHeartbeat >= static_cast<ULONGLONG>(g_options.heartbeatMs))
        {
            observedUptime = afterDrain - startTick;
            EmitHeartbeat(observedUptime, g_lastMouseEventTick.load(std::memory_order_relaxed),
                          g_lastKeyEventTick.load(std::memory_order_relaxed));
            lastHeartbeat = afterDrain;
        }
        if (deadline != 0 && afterDrain >= deadline)
            break;
    }
    observedUptime = GetTickCount64() - startTick;
    return kExitOk;
}

}  // namespace

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------
int main(int argc, char **argv)
{
    Options options;
    bool helpRequested = false;
    if (!ParseArgs(argc, argv, options, helpRequested))
    {
        if (helpRequested)
            return kExitOk;  // --help already printed the usage text.
        PrintUsage();
        return kExitInvalidArgs;
    }
    g_options = options;

    // Startup beacon: everything after this point is one JSON line per event.
    {
        helper::JsonLine line;
        line.Envelope("helper-start").Str("version", kHelperVersion).Bool("selfTest", options.selfTest);
        helper::Emit(line);
    }

    EnableDpiAwareness();
    g_doubleClickTimeMs = GetDoubleClickTime();

    g_wakeEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_hookReadyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_hookStopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_wakeEvent || !g_hookReadyEvent || !g_hookStopEvent)
    {
        EmitError("startup", kExitRuntimeError, "failed to create runtime events", GetLastError());
        return kExitRuntimeError;
    }
    SetConsoleCtrlHandler(ConsoleControlHandler, TRUE);

    EmitEnvironmentProbe();

    // Prototype-only negative-path injection so the error branches can be evidenced
    // without waiting for a real COM/hook failure on this machine.
    if (options.simulateFailure == "uia")
    {
        EmitError("uia-init", kExitUiaInitFailed, "simulated UIA initialization failure (--simulate-failure=uia)");
        EmitStatus("self-test-fail");
        return kExitUiaInitFailed;
    }

    g_gates = MakeGates();
    g_clipboardSequenceState = std::make_shared<ClipboardSequenceState>();

    if (options.simulateFailure == "hook")
    {
        EmitError("hook-install", kExitHookInstallFailed, "simulated hook install failure (--simulate-failure=hook)");
        EmitStatus("self-test-fail");
        return kExitHookInstallFailed;
    }

    RetrievalWorker worker(g_gates,
                           [](const SelectionWorkerResult &result, RetrievalStage stage, unsigned long long elapsedMs)
                           { OnRetrievalResult(result, stage, elapsedMs); });
    g_worker = &worker;

    RetrievalWorkerSelfTest selfTest;
    std::string workerError;
    if (!worker.Start(selfTest, workerError))
    {
        EmitError("uia-init", kExitUiaInitFailed, workerError, 0, selfTest.initializationHr);
        EmitStatus("self-test-fail");
        return kExitUiaInitFailed;
    }
    {
        helper::JsonLine line;
        line.Envelope("uia-ready")
            .Bool("comInitialized", SUCCEEDED(static_cast<HRESULT>(selfTest.initializationHr)))
            .Str("initializationHr", HexValue(selfTest.initializationHr))
            .Bool("rootElementProbe", selfTest.uiaProbeOk)
            .UInt("rootControlType", static_cast<unsigned long long>(selfTest.rootControlType))
            .Str("rootName", helper::WideToUtf8(selfTest.rootName))
            .Str("workerError", selfTest.error);
        helper::Emit(line);
    }

    std::thread hookThread(HookThreadProc);
    if (WaitForSingleObject(g_hookReadyEvent, kHookReadyTimeoutMs) != WAIT_OBJECT_0)
    {
        EmitError("hook-install", kExitHookInstallFailed, "timed out waiting for hook thread");
        g_stopRequested.store(true);
        SetEvent(g_hookStopEvent);
        if (hookThread.joinable())
            hookThread.join();
        worker.Stop();
        EmitStatus("self-test-fail");
        return kExitHookInstallFailed;
    }
    {
        helper::JsonLine line;
        line.Envelope("hook-ready")
            .Bool("mouseHook", g_mouseHookOk.load())
            .Bool("keyboardHook", g_keyboardHookOk.load())
            .UInt("win32Error", g_hookInstallError.load());
        helper::Emit(line);
    }
    if (!g_hookInstalled.load())
    {
        EmitError("hook-install", kExitHookInstallFailed, "SetWindowsHookEx failed", g_hookInstallError.load());
        g_stopRequested.store(true);
        SetEvent(g_hookStopEvent);
        if (hookThread.joinable())
            hookThread.join();
        worker.Stop();
        EmitStatus("self-test-fail");
        return kExitHookInstallFailed;
    }

    // Startup summary used by the automation driver and by the doc evidence table.
    {
        helper::JsonLine line;
        line.Envelope("status")
            .Str("status", "started")
            .Str("version", kHelperVersion)
            .Bool("selfTest", options.selfTest)
            .Bool("clipboardFallback", options.clipboard)
            .Bool("mouseEvents", options.mouseEvents)
            .Bool("keyboardEvents", options.keyboardEvents)
            .UInt("durationMs", static_cast<unsigned long long>(options.durationMs))
            .UInt("heartbeatMs", static_cast<unsigned long long>(options.heartbeatMs))
            .Str("dpiAwareness", "per-monitor-v1")
            .UInt("doubleClickTimeMs", g_doubleClickTimeMs)
            .Str("initializationHr", HexValue(selfTest.initializationHr))
            .Bool("rootElementProbe", selfTest.uiaProbeOk)
            .Bool("mouseHook", g_mouseHookOk.load())
            .Bool("keyboardHook", g_keyboardHookOk.load());
        helper::Emit(line);
    }

    int runDurationMs = options.durationMs;
    if (runDurationMs == 0 && options.selfTest)
        runDurationMs = 1500;  // Self-test needs at least one heartbeat cycle.

    unsigned long long observedUptime = 0;
    RunLoop(static_cast<DWORD>(runDurationMs), observedUptime);

    EmitStatus("stopping");
    g_stopRequested.store(true, std::memory_order_release);
    SetEvent(g_hookStopEvent);
    if (hookThread.joinable())
        hookThread.join();

    const bool workerCleanStop = worker.Stop();
    if (!workerCleanStop)
        EmitError("worker-stop", kExitRuntimeError, "selection worker stop timed out; thread abandoned");

    const bool selfTestPass =
        SUCCEEDED(static_cast<HRESULT>(selfTest.initializationHr)) && selfTest.uiaProbeOk && g_mouseHookOk.load() &&
        g_keyboardHookOk.load() && workerCleanStop;
    const bool selectionSeen = g_selectionSeen.load(std::memory_order_acquire);

    int exitCode = kExitOk;
    if (options.selfTest && !selfTestPass)
        exitCode = kExitSelfTestFailed;
    if (options.exitAfterSelection && !selectionSeen)
        exitCode = kExitSelectionTimeout;

    if (options.selfTest)
    {
        helper::JsonLine line;
        line.Envelope("status")
            .Str("status", selfTestPass ? "self-test-pass" : "self-test-fail")
            .Bool("comUiaInit", SUCCEEDED(static_cast<HRESULT>(selfTest.initializationHr)))
            .Bool("rootElementProbe", selfTest.uiaProbeOk)
            .Bool("mouseHook", g_mouseHookOk.load())
            .Bool("keyboardHook", g_keyboardHookOk.load())
            .Bool("workerCleanStop", workerCleanStop)
            .Bool("selectionSeen", selectionSeen)
            .UInt("uptimeMs", observedUptime)
            .Int("exitCode", exitCode);
        helper::Emit(line);
    }
    {
        helper::JsonLine line;
        line.Envelope("status")
            .Str("status", "stopped")
            .Bool("selectionSeen", selectionSeen)
            .UInt("autoRetrievals", g_autoRetrievals.load(std::memory_order_relaxed))
            .UInt("retrievalsCompleted", g_retrievalsCompleted.load(std::memory_order_relaxed))
            .UInt("selectionsFound", g_selectionsFound.load(std::memory_order_relaxed))
            .UInt("mouseEventsQueued", g_mouseEventsQueued.load(std::memory_order_relaxed))
            .UInt("keyboardEventsQueued", g_keyboardEventsQueued.load(std::memory_order_relaxed))
            .Int("exitCode", exitCode);
        helper::Emit(line);
    }

    g_worker = nullptr;
    if (g_wakeEvent)
        CloseHandle(g_wakeEvent);
    if (g_hookReadyEvent)
        CloseHandle(g_hookReadyEvent);
    if (g_hookStopEvent)
        CloseHandle(g_hookStopEvent);
    std::fprintf(stderr, "[selection-helper] exit=%d uptime=%llu ms\n", exitCode, observedUptime);
    return exitCode;
}
