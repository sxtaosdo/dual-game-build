"""Pinned Windows paths and handle-relative, no-reparse migration IO.

Writes are restricted to workspace/P4000/ant-cook, create-only. No deletion,
permission changes or privileges. Requests and replies are bounded JSON lines.
"""
import ctypes
from ctypes import wintypes
import json
import os
import sys
import base64
import hashlib

if os.name != 'nt':
    raise RuntimeError('Windows directory leases are required for migration')

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
kernel.ReadFile.restype = wintypes.BOOL
kernel.WriteFile.argtypes = kernel.ReadFile.argtypes
kernel.WriteFile.restype = wintypes.BOOL
kernel.SetFilePointerEx.argtypes = [wintypes.HANDLE, ctypes.c_longlong, ctypes.c_void_p, wintypes.DWORD]
kernel.SetFilePointerEx.restype = wintypes.BOOL
ntdll = ctypes.WinDLL('ntdll')

class UnicodeString(ctypes.Structure):
    _fields_ = [('length', wintypes.USHORT), ('maximum_length', wintypes.USHORT), ('buffer', wintypes.LPWSTR)]

class ObjectAttributes(ctypes.Structure):
    _fields_ = [('length', wintypes.ULONG), ('root', wintypes.HANDLE), ('name', ctypes.POINTER(UnicodeString)),
                ('attributes', wintypes.ULONG), ('security', ctypes.c_void_p), ('qos', ctypes.c_void_p)]

class IoStatus(ctypes.Structure):
    _fields_ = [('status', ctypes.c_void_p), ('information', ctypes.c_size_t)]

ntdll.NtCreateFile.argtypes = [ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, ctypes.POINTER(ObjectAttributes),
    ctypes.POINTER(IoStatus), ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG]
ntdll.NtCreateFile.restype = wintypes.LONG
if ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ObjectAttributes) != 48 or ctypes.sizeof(IoStatus) != 16:
    raise RuntimeError('Only validated Windows x64 ABI is supported')

class AttributeTag(ctypes.Structure):
    _fields_ = [('attributes', wintypes.DWORD), ('tag', wintypes.DWORD)]

handles = {}
boundary = os.path.abspath(sys.argv[1])
workspace = os.path.abspath(sys.argv[2])
write_root = os.path.join(workspace, 'P4000', 'ant-cook')
def normalized(path):
    return os.path.normcase(os.path.abspath(path)).rstrip('\\')

def acquire(path):
    absolute = os.path.abspath(path)
    relative = os.path.relpath(absolute, boundary)
    if relative.startswith('..') or os.path.isabs(relative):
        raise RuntimeError('Path outside lease boundary: ' + absolute)
    current = boundary
    for part in [''] + ([] if relative == '.' else relative.split('\\')):
        current = os.path.join(current, part) if part else current
        key = normalized(current)
        if key in handles:
            validate(handles[key], current)
            continue
        # OPEN_EXISTING, OPEN_REPARSE_POINT, BACKUP_SEMANTICS; no DELETE sharing.
        handle = kernel.CreateFileW(current, 0, 1 | 2, None, 3, 0x00200000 | 0x02000000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise RuntimeError(str(ctypes.WinError(ctypes.get_last_error())) + ': ' + current)
        try:
            validate(handle, current)
            handles[key] = handle
        except BaseException:
            kernel.CloseHandle(handle)
            raise

def validate(handle, expected, directory=None):
    info = AttributeTag()
    if not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if info.attributes & 0x400:
        raise RuntimeError('Unsafe symlink/junction handle: ' + expected)
    if directory is not None and bool(info.attributes & 0x10) != directory:
        raise RuntimeError('Unexpected file type: ' + expected)
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
    if not length or length >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    physical = buffer.value
    if physical.startswith('\\\\?\\UNC\\'): physical = '\\\\' + physical[8:]
    elif physical.startswith('\\\\?\\'): physical = physical[4:]
    if normalized(physical) != normalized(expected):
        raise RuntimeError('Physical path mismatch: ' + expected)

def relative_open(path, directory=False, create=False):
    absolute = os.path.abspath(path)
    parent, name = os.path.split(absolute)
    if not name or name in ('.', '..') or any(c in name for c in '\\/:\x00') or name[-1] in ' .':
        raise RuntimeError('Invalid path component')
    if create and os.path.commonpath([write_root, absolute]).lower() != write_root.lower():
        raise RuntimeError('Write outside approved product')
    acquire(parent)
    parent_handle = handles[normalized(parent)]
    validate(parent_handle, parent, True)
    buffer = ctypes.create_unicode_buffer(name)
    encoded_length = len(name.encode('utf-16-le'))
    unicode = UnicodeString(encoded_length, encoded_length + 2, ctypes.cast(buffer, wintypes.LPWSTR))
    attributes = ObjectAttributes(ctypes.sizeof(ObjectAttributes), parent_handle, ctypes.pointer(unicode), 0x40 | 0x1000, None, None)
    handle, io = wintypes.HANDLE(), IoStatus()
    # Synchronous IO requires SYNCHRONIZE. Directory create uses no reparse option;
    # OBJ_DONT_REPARSE applies to resolution, attributes are verified afterwards.
    access = 0x00100080 if directory else 0x00100081 | (0x2 if create else 0)
    options = 0x20 | (0x1 if directory else 0x40 | 0x00200000)
    status = ntdll.NtCreateFile(ctypes.byref(handle), access, ctypes.byref(attributes), ctypes.byref(io), None,
        0x80, 1 | 2, 2 if create else 1, options, None, 0)
    if status != 0:
        raise RuntimeError('NtCreateFile failed 0x%08x: %s' % (status & 0xffffffff, absolute))
    try: validate(handle, absolute, directory)
    except BaseException:
        kernel.CloseHandle(handle); raise
    return handle

def read_handle(handle):
    chunks, total = [], 0
    while True:
        buffer, count = ctypes.create_string_buffer(1024 * 1024), wintypes.DWORD()
        if not kernel.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None):
            raise ctypes.WinError(ctypes.get_last_error())
        if not count.value: break
        total += count.value
        if total > 64 * 1024 * 1024: raise RuntimeError('File exceeds migration IO limit')
        chunks.append(buffer.raw[:count.value])
    return b''.join(chunks)

def handle_request(request):
    operation, path = request.get('op', 'lock'), request['path']
    if operation == 'lock': acquire(path); return {}
    if operation == 'mkdir':
        handle = relative_open(path, directory=True, create=True)
        handles[normalized(path)] = handle
        return {}
    if operation == 'read':
        handle = relative_open(path)
        try: return {'bytes': base64.b64encode(read_handle(handle)).decode('ascii')}
        finally: kernel.CloseHandle(handle)
    if operation != 'write': raise RuntimeError('Unsupported operation')
    data = base64.b64decode(request['bytes'], validate=True)
    if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != request['sha256']:
        raise RuntimeError('Invalid write bytes/hash')
    handle = relative_open(path, create=True)
    try:
        offset = 0
        while offset < len(data):
            chunk = data[offset:offset + 1024 * 1024]
            count = wintypes.DWORD()
            if not kernel.WriteFile(handle, chunk, len(chunk), ctypes.byref(count), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not count.value: raise RuntimeError('Zero-length write')
            offset += count.value
        if not kernel.SetFilePointerEx(handle, 0, None, 0): raise ctypes.WinError(ctypes.get_last_error())
        if hashlib.sha256(read_handle(handle)).hexdigest() != request['sha256']:
            raise RuntimeError('Written file hash mismatch')
        handles[normalized(path)] = handle
        return {'sha256': request['sha256']}
    except BaseException:
        kernel.CloseHandle(handle); raise

try:
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        try:
            if len(line) > 90 * 1024 * 1024: raise RuntimeError('Request exceeds migration IO limit')
            result = handle_request(json.loads(line))
            print(json.dumps({'ok': True, **result}), flush=True)
        except Exception as error:
            print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
finally:
    for handle in reversed(list(handles.values())):
        kernel.CloseHandle(handle)
