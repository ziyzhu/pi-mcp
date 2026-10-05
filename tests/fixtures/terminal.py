import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))

def stop(signum, frame):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                stop(None, None)
                break
            os.write(master, data)
finally:
    stop(None, None)
    os.close(master)
    os.waitpid(pid, 0)
