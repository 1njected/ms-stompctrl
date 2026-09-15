/* Private Frida/Electra ABI adapter for this Amethyst iPad.
 * No system library is replaced. The patched server loads this temporary file.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>

typedef void (*entitle_fn)(pid_t, uint32_t);
__attribute__((visibility("default")))
int jbd_call(uint32_t unused_port, unsigned command, unsigned pid) {
    (void)unused_port;
    const char *allowed = getenv("STOMP_TRACE_PID");
    if (command != 1 || (pid != (unsigned)getpid() &&
        (!allowed || pid != (unsigned)strtoul(allowed, NULL, 10)))) {
        fprintf(stderr, "stomp-compat: refusing command=%u pid=%u\n", command, pid);
        return EPERM;
    }
    void *lib = dlopen("/usr/lib/libjailbreak.dylib", RTLD_LAZY | RTLD_LOCAL);
    entitle_fn entitle = lib ? (entitle_fn)dlsym(lib, "jb_oneshot_entitle_now") : NULL;
    if (!entitle) {
        fprintf(stderr, "stomp-compat: missing Amethyst API: %s\n", dlerror());
        return ENOSYS;
    }
    /* FLAG_PLATFORMIZE only; do not request sandbox or credential changes. */
    entitle((pid_t)pid, 1u << 1);
    fprintf(stderr, "stomp-compat: platformize requested pid=%u\n", pid);
    dlclose(lib);
    return 0; /* Amethyst's public API returns void; not proof of success. */
}
