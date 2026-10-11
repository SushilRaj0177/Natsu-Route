"""Read single entries out of a remote zip with HTTP range requests.

PLATEAU publishes each ward as one 0.3–2.5 GB zip holding every feature type
(buildings, roads, flood maps, textures...). We only need a few folders, so
instead of downloading the whole archive we read its central directory and
then stream just the entries we want.
"""
import io
import time
import urllib.request
import zipfile


class HttpFile(io.RawIOBase):
    def __init__(self, url: str, block: int = 4 << 20):
        self.url = url
        self.pos = 0
        self.block = block
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self, offset, whence=0):
        if whence == 0:
            self.pos = offset
        elif whence == 1:
            self.pos += offset
        else:
            self.pos = self.size + offset
        return self.pos

    def tell(self):
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        for attempt in range(6):
            try:
                req = urllib.request.Request(
                    self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"}
                )
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)
        b[: len(data)] = data
        self.pos += len(data)
        return len(data)


def open_remote_zip(url: str, buffer: int = 8 << 20) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BufferedReader(HttpFile(url), buffer_size=buffer))
