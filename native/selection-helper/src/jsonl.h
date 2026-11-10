/**
 * @file
 * @brief Minimal JSON Lines writer used by the R0-04 selection helper prototype.
 *
 * This file is prototype-only (R0 evidence): it deliberately has no dependencies on
 * Node-API, Electron or the product build. Every event is one UTF-8 JSON object on one
 * line, flushed immediately so a parent process can consume the stream as a pipe.
 */
#pragma once

#define WIN32_LEAN_AND_MEAN 1

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>

namespace helper
{

/** @brief One process-wide lock so hook/worker/main threads never interleave a line. */
inline std::mutex &OutputMutex()
{
    static std::mutex mutex;
    return mutex;
}

/** @brief Append UTF-8 bytes as a JSON string body (without surrounding quotes). */
inline void AppendJsonEscaped(std::string &out, const std::string &utf8)
{
    for (const unsigned char c : utf8)
    {
        switch (c)
        {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\b':
                out += "\\b";
                break;
            case '\f':
                out += "\\f";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20)
                {
                    char buffer[8] = {};
                    std::snprintf(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned int>(c));
                    out += buffer;
                }
                else
                {
                    out += static_cast<char>(c);
                }
                break;
        }
    }
}

/** @brief Convert a wide string to UTF-8 (invalid surrogates become U+FFFD lossy). */
inline std::string WideToUtf8(const std::wstring &text)
{
    if (text.empty())
        return std::string();
    const int needed = ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0,
                                            nullptr, nullptr);
    if (needed <= 0)
        return std::string();
    std::string result(static_cast<size_t>(needed), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), needed, nullptr,
                          nullptr);
    return result;
}

/** @brief UTC wall-clock timestamp in ISO-8601 form, e.g. 2026-11-10T15:05:00.123Z. */
inline std::string UtcTimestamp()
{
    SYSTEMTIME systemTime = {};
    ::GetSystemTime(&systemTime);
    char buffer[40] = {};
    std::snprintf(buffer, sizeof(buffer), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
                  static_cast<unsigned int>(systemTime.wYear), static_cast<unsigned int>(systemTime.wMonth),
                  static_cast<unsigned int>(systemTime.wDay), static_cast<unsigned int>(systemTime.wHour),
                  static_cast<unsigned int>(systemTime.wMinute), static_cast<unsigned int>(systemTime.wSecond),
                  static_cast<unsigned int>(systemTime.wMilliseconds));
    return std::string(buffer);
}

/** @brief Monotonic milliseconds since process start (GetTickCount64 based). */
inline unsigned long long UptimeMs()
{
    static const ULONGLONG origin = ::GetTickCount64();
    return static_cast<unsigned long long>(::GetTickCount64() - origin);
}

/**
 * @brief Incremental JSON object builder with a fixed key order.
 *
 * The prototype intentionally keeps every event flat: beacons/heartbeats are lines in
 * the same stream as selection results so a single reader can order them.
 */
class JsonLine
{
  public:
    JsonLine &Str(const char *key, const std::string &value)
    {
        AppendKey(key);
        buffer_ += '"';
        AppendJsonEscaped(buffer_, value);
        buffer_ += '"';
        return *this;
    }

    JsonLine &WStr(const char *key, const std::wstring &value) { return Str(key, WideToUtf8(value)); }

    JsonLine &Int(const char *key, long long value)
    {
        AppendKey(key);
        buffer_ += std::to_string(value);
        return *this;
    }

    JsonLine &UInt(const char *key, unsigned long long value)
    {
        AppendKey(key);
        buffer_ += std::to_string(value);
        return *this;
    }

    JsonLine &Bool(const char *key, bool value)
    {
        AppendKey(key);
        buffer_ += value ? "true" : "false";
        return *this;
    }

    /** @brief Emit a pointer-ish value as a string so JSON consumers keep the exact hex. */
    JsonLine &Hex(const char *key, unsigned long long value)
    {
        char buffer[24] = {};
        std::snprintf(buffer, sizeof(buffer), "0x%llx", value);
        return Str(key, std::string(buffer));
    }

    JsonLine &Point(const char *key, const POINT &point)
    {
        AppendKey(key);
        buffer_ += "{\"x\":";
        buffer_ += std::to_string(point.x);
        buffer_ += ",\"y\":";
        buffer_ += std::to_string(point.y);
        buffer_ += '}';
        return *this;
    }

    /** @brief Add the common envelope fields (type + timestamp + uptime). */
    JsonLine &Envelope(const char *type)
    {
        return Str("type", type).Str("time", UtcTimestamp()).UInt("uptimeMs", UptimeMs()).UInt("pid", ::GetCurrentProcessId());
    }

    std::string Finish() const { return buffer_ + "}"; }

  private:
    void AppendKey(const char *key)
    {
        if (buffer_.empty())
        {
            buffer_ = "{";
        }
        else
        {
            buffer_ += ',';
        }
        buffer_ += '"';
        buffer_ += key;
        buffer_ += "\":";
    }

    std::string buffer_;
};

/** @brief Serialize and flush one JSON line to stdout. */
inline void Emit(const JsonLine &line)
{
    const std::string serialized = line.Finish();
    std::lock_guard<std::mutex> lock(OutputMutex());
    std::fwrite(serialized.data(), 1, serialized.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

}  // namespace helper
