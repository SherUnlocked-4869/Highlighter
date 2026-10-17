/**
 * Clipboard utility functions for text selection hook
 *
 * Copyright (c) 2025 0xfullex (https://github.com/0xfullex/selection-hook)
 * Licensed under the MIT License
 */

#include "clipboard.h"

#include <vector>
#include <cwchar>

/**
 * Check if a clipboard format should be skipped during backup.
 *
 * Skipped categories:
 * - Synthesized formats: Windows auto-generates these from other formats
 * - Non-backupable formats: handle is not HGLOBAL or always NULL
 * - Private formats: handle type is application-defined, unsafe to GlobalLock
 */
static bool IsSkippedFormat(UINT format)
{
    switch (format)
    {
        // Synthesized from CF_UNICODETEXT
        case CF_TEXT:
        case CF_OEMTEXT:
        case CF_LOCALE:
        // Synthesized from CF_DIB
        case CF_BITMAP:
        case CF_PALETTE:
        // Synthesized from CF_ENHMETAFILE
        case CF_METAFILEPICT:
        // Handle is always NULL
        case CF_OWNERDISPLAY:
            return true;
        default:
            break;
    }

    // CF_DSP* display formats (for clipboard viewers only, non-standard handles)
    if (format == CF_DSPTEXT || format == CF_DSPBITMAP || format == CF_DSPMETAFILEPICT || format == CF_DSPENHMETAFILE)
        return true;

    // Private format range: handle type is application-defined, cannot safely GlobalLock
    if (format >= CF_PRIVATEFIRST && format <= CF_PRIVATELAST)
        return true;

    // GDI object range: extremely rare, system does not auto-free on EmptyClipboard
    if (format >= CF_GDIOBJFIRST && format <= CF_GDIOBJLAST)
        return true;

    return false;
}

/**
 * Reads text from clipboard
 * @param content [out] The string to store clipboard content
 * @param isClipboardOpened If true, assumes clipboard is already opened
 * @return true if successful, false otherwise
 */
bool ReadClipboard(std::wstring &content, bool isClipboardOpened)
{
    if (!isClipboardOpened && !OpenClipboard(nullptr))
        return false;

    bool success = false;
    HANDLE hData = GetClipboardData(CF_UNICODETEXT);
    if (hData)
    {
        // Handle Unicode text (most common)
        const SIZE_T size = GlobalSize(hData);
        wchar_t *pText = size >= sizeof(wchar_t) && size <= 2 * 1024 * 1024 && size % sizeof(wchar_t) == 0
            ? static_cast<wchar_t *>(GlobalLock(hData)) : nullptr;
        if (pText)
        {
            struct UnlockGuard { HANDLE handle; ~UnlockGuard() { GlobalUnlock(handle); } } unlockGuard{hData};
            const wchar_t *end = std::wmemchr(pText, L'\0', size / sizeof(wchar_t));
            if (end) content.assign(pText, static_cast<size_t>(end - pText));
            success = end != nullptr;
        }
    }
    else
    {
        // Fallback to CF_TEXT if CF_UNICODETEXT is not available
        hData = GetClipboardData(CF_TEXT);
        if (hData)
        {
            const SIZE_T size = GlobalSize(hData);
            char *pText = size > 0 && size <= 2 * 1024 * 1024 ? static_cast<char *>(GlobalLock(hData)) : nullptr;
            if (pText)
            {
                struct UnlockGuard { HANDLE handle; ~UnlockGuard() { GlobalUnlock(handle); } } unlockGuard{hData};
                // Convert ANSI text to wide string
                const char *end = static_cast<const char *>(memchr(pText, '\0', size));
                const int sourceLength = end ? static_cast<int>(end - pText) : -1;
                int length = sourceLength >= 0 ? MultiByteToWideChar(CP_ACP, 0, pText, sourceLength, nullptr, 0) : 0;
                if (length > 0)
                {
                    std::vector<wchar_t> buffer(length);
                    MultiByteToWideChar(CP_ACP, 0, pText, sourceLength, buffer.data(), length);
                    content.assign(buffer.data(), buffer.size());
                    success = true;
                }
            }
        }
    }

    if (!isClipboardOpened)
        CloseClipboard();

    return success;
}

/**
 * Writes text to clipboard
 * @param content The string to write to clipboard
 * @return true if successful, false otherwise
 */
bool WriteClipboard(const std::wstring &content)
{
    if (!OpenClipboard(nullptr))
        return false;

    EmptyClipboard();
    bool success = false;

    if (!content.empty())
    {
        size_t size = (content.size() + 1) * sizeof(wchar_t);
        HANDLE hData = GlobalAlloc(GMEM_MOVEABLE, size);
        if (hData)
        {
            wchar_t *pText = static_cast<wchar_t *>(GlobalLock(hData));
            if (pText)
            {
                memcpy(pText, content.c_str(), size);
                GlobalUnlock(hData);
                if (SetClipboardData(CF_UNICODETEXT, hData) != nullptr)
                {
                    success = true;
                }
                else
                {
                    GlobalFree(hData);
                }
            }
            else
            {
                GlobalFree(hData);
            }
        }
    }

    CloseClipboard();
    return success;
}

/**
 * Backs up ALL clipboard formats into a ClipboardBackup structure.
 * Iterates all formats via EnumClipboardFormats, skipping synthesized and
 * non-backupable formats. CF_ENHMETAFILE gets special handling via
 * GetEnhMetaFileBits since it uses HENHMETAFILE instead of HGLOBAL.
 */
bool BackupClipboard(ClipboardBackup &backup, bool isClipboardOpened)
{
    backup.formats.clear();
    backup.isEmpty = true;

    if (!isClipboardOpened && !OpenClipboard(nullptr))
        return false;

    struct CloseGuard { bool close; ~CloseGuard() { if (close) CloseClipboard(); } } closeGuard{!isClipboardOpened};
    constexpr SIZE_T maximumBackupBytes = 64 * 1024 * 1024;
    SIZE_T remaining = maximumBackupBytes;
    unsigned formats = 0;

    if (CountClipboardFormats() == 0)
    {
        return true;  // Success, but clipboard was empty
    }

    backup.isEmpty = false;

    UINT format = 0;
    for (;;)
    {
        SetLastError(ERROR_SUCCESS);
        format = EnumClipboardFormats(format);
        if (format == 0) break;
        if (++formats > 64) return false;
        // These cannot be copied losslessly as HGLOBAL. Abort before clearing,
        // instead of discarding private or GDI-only data during fallback.
        if ((format >= CF_PRIVATEFIRST && format <= CF_PRIVATELAST)
            || (format >= CF_GDIOBJFIRST && format <= CF_GDIOBJLAST)
            || format == CF_OWNERDISPLAY || format == CF_DSPTEXT || format == CF_DSPBITMAP
            || format == CF_DSPMETAFILEPICT || format == CF_DSPENHMETAFILE) return false;
        if (IsSkippedFormat(format))
            continue;

        // CF_ENHMETAFILE uses HENHMETAFILE, not HGLOBAL
        if (format == CF_ENHMETAFILE)
        {
            HENHMETAFILE hEmf = static_cast<HENHMETAFILE>(GetClipboardData(CF_ENHMETAFILE));
            if (!hEmf) return false;

            UINT emfSize = GetEnhMetaFileBits(hEmf, 0, nullptr);
            if (emfSize == 0 || emfSize > remaining) return false;

            ClipboardFormatEntry entry;
            entry.format = CF_ENHMETAFILE;
            entry.dataSize = emfSize;
            entry.data.resize(emfSize);
            if (GetEnhMetaFileBits(hEmf, emfSize, entry.data.data()) != emfSize) return false;
            remaining -= emfSize;
            backup.formats.push_back(std::move(entry));
            continue;
        }

        // Generic HGLOBAL path for all other formats
        HANDLE hData = GetClipboardData(format);
        if (!hData) return false;

        SIZE_T dataSize = GlobalSize(hData);
        if (dataSize == 0 || dataSize > remaining) return false;

        void *pData = GlobalLock(hData);
        if (!pData) return false;

        struct UnlockGuard { HANDLE handle; ~UnlockGuard() { GlobalUnlock(handle); } } unlockGuard{hData};

        ClipboardFormatEntry entry;
        entry.format = format;
        entry.dataSize = dataSize;
        entry.data.resize(dataSize);
        memcpy(entry.data.data(), pData, dataSize);
        remaining -= dataSize;

        backup.formats.push_back(std::move(entry));
    }

    return GetLastError() == ERROR_SUCCESS && (backup.isEmpty || backup.HasData());
}

/**
 * Restores all clipboard formats from a ClipboardBackup structure.
 * Calls EmptyClipboard first, then sets each backed-up format.
 * CF_ENHMETAFILE is restored via SetEnhMetaFileBits.
 * On SetClipboardData failure, the allocated handle is freed by us.
 */
bool RestoreClipboard(const ClipboardBackup &backup, bool isClipboardOpened, const std::function<bool()> &mayWrite)
{
    if (!backup.isEmpty && !backup.HasData()) return false;

    if (!isClipboardOpened && !OpenClipboard(nullptr))
        return false;

    struct CloseGuard { bool close; ~CloseGuard() { if (close) CloseClipboard(); } } closeGuard{!isClipboardOpened};

    if ((mayWrite && !mayWrite()) || !EmptyClipboard()) return false;
    bool success = true;
    DWORD ownedSequence = GetClipboardSequenceNumber();

    for (const auto &entry : backup.formats)
    {
        if ((mayWrite && !mayWrite()) || GetClipboardSequenceNumber() != ownedSequence) return false;
        // CF_ENHMETAFILE uses HENHMETAFILE, not HGLOBAL
        if (entry.format == CF_ENHMETAFILE)
        {
            HENHMETAFILE hEmf = SetEnhMetaFileBits(static_cast<UINT>(entry.dataSize), entry.data.data());
            if (hEmf)
            {
                if (mayWrite && !mayWrite()) { DeleteEnhMetaFile(hEmf); return false; }
                if (SetClipboardData(CF_ENHMETAFILE, hEmf) == nullptr)
                {
                    DeleteEnhMetaFile(hEmf);  // Not GlobalFree -- this is a GDI handle
                    success = false;
                }
            }
            else success = false;
            ownedSequence = GetClipboardSequenceNumber();
            continue;
        }

        // Generic HGLOBAL path
        HGLOBAL hData = GlobalAlloc(GMEM_MOVEABLE, entry.dataSize);
        if (!hData) { success = false; continue; }

        void *pDest = GlobalLock(hData);
        if (!pDest)
        {
            GlobalFree(hData);
            success = false;
            continue;
        }

        memcpy(pDest, entry.data.data(), entry.dataSize);
        GlobalUnlock(hData);

        if ((mayWrite && !mayWrite()) || GetClipboardSequenceNumber() != ownedSequence) { GlobalFree(hData); return false; }

        if (SetClipboardData(entry.format, hData) == nullptr)
        {
            GlobalFree(hData);  // On failure, we must free the handle ourselves
            success = false;
        }
        // On success, system owns hData -- do NOT free
        ownedSequence = GetClipboardSequenceNumber();
    }

    return success;
}
