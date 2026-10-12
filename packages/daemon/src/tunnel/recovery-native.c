typedef int (*openat_fn)(int, const char *, int, ...);
typedef int *(*errno_fn)(void);
typedef int (*flock_fn)(int, int);
typedef int (*fcntl_fn)(int, int, ...);
typedef int (*unlinkat_fn)(int, const char *, int);
/* Public O_CLOEXEC constants on the three supported 64-bit host ABIs (ADR 0040).
 * The fixed call handles Darwin ARM64's variadic openat calling convention.
 * Capture errno in the same native call: only exact ENOENT authorizes absence.
 */
int remi_recovery_open(void *function, void *errors, int darwin, int directory,
                       const char *name, int flags, int mode) {
    int result = ((openat_fn)function)(directory, name,
        flags | (darwin ? 0x1000000 : 0x80000), mode);
    return result < 0 ? -*((errno_fn)errors)() : result;
}
int remi_recovery_lock(void *function, void *errors, int descriptor) {
    int result = ((flock_fn)function)(descriptor, 2 | 4);
    return result < 0 ? -*((errno_fn)errors)() : result;
}
int remi_recovery_cloexec(void *function, int descriptor) {
    return ((fcntl_fn)function)(descriptor, 1); /* F_GETFD; FD_CLOEXEC is bit 1. */
}
int remi_recovery_unlink(void *function, void *errors, int directory, const char *name) {
    int result = ((unlinkat_fn)function)(directory, name, 0);
    return result < 0 ? -*((errno_fn)errors)() : result;
}
