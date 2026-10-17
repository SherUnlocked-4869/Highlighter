#pragma once

#ifndef HIGHLIGHTER_SELECTION_BUILD_ID
#error Highlighter selection-hook must be built from its source binding.gyp
#endif

#define HL_STRINGIFY_INNER(value) #value
#define HL_STRINGIFY(value) HL_STRINGIFY_INNER(value)
