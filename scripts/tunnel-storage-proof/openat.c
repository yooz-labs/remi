typedef int (*openat_fn)(int, const char *, int, ...);
int remi_openat_create(openat_fn function, int directory, const char *name, int flags, int mode) {
    return function(directory, name, flags, mode);
}

/* Owned fixture only: allocate extra blocks without altering logical bytes.
 * Darwin's public fstore_t layout/constants were checked against MacOSX27.0 SDK.
 * The fixed wrapper keeps Darwin ARM64 variadic fcntl out of the FFI call ABI.
 * Linux ARM64/x64 off_t and Darwin off_t are both 64-bit on supported targets.
 */
typedef int (*fcntl_fn)(int, int, ...);
typedef int (*fallocate_fn)(int, int, long long, long long);
struct remi_fstore {
    unsigned int flags;
    int posmode;
    long long offset;
    long long length;
    long long bytesallocated;
};
int remi_preallocate_owned(void *function, int darwin, int descriptor) {
    if (darwin) {
        struct remi_fstore store = {4, 3, 0, 16384, 0};
        return ((fcntl_fn)function)(descriptor, 42, &store);
    }
    /* FALLOC_FL_KEEP_SIZE: additional allocation does not extend st_size. */
    return ((fallocate_fn)function)(descriptor, 1, 0, 16384);
}
