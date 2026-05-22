// Stub: replace fldigi's logging macros with no-ops.
#pragma once
#define LOG_DEBUG(...)   ((void)0)
#define LOG_INFO(...)    ((void)0)
#define LOG_VERBOSE(...) ((void)0)
#define LOG_WARN(...)    ((void)0)
#define LOG_ERROR(...)   ((void)0)
#define LOG_QUIET(...)   ((void)0)
#define LOG(...)         ((void)0)
#define LOG_FILE_SOURCE(...) namespace {}
namespace debug { enum { LOG_MODEM, LOG_RSID, LOG_OTHER }; }
