typedef int (*openat_fn)(int, const char *, int, ...);
int remi_openat_create(openat_fn function, int directory, const char *name, int flags, int mode) {
    return function(directory, name, flags, mode);
}
