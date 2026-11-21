"""Small web fetches that don't hang on a broken IPv6 route.

2026-11-17: on a home network with IPv6 half-up, Python tried the IPv6 address first and "what's the weather"
timed out every time, while the same request over IPv4 answered in a second. So: a quick normal try, then IPv4 only.
"""
from __future__ import annotations

import http.client
import socket
import urllib.error
import urllib.request
from typing import Any, Tuple, Union


def _v4_connect(address: Tuple[str, int], timeout: Any = socket._GLOBAL_DEFAULT_TIMEOUT, source_address: Any = None, **_: Any) -> socket.socket:
    host, port = address
    last: Exception = OSError(f"no IPv4 address for {host}")
    for family, kind, proto, _name, sockaddr in socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM):
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last = exc
            sock.close()
    raise last


class _V4HTTPS(http.client.HTTPSConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _v4_connect


class _V4HTTP(http.client.HTTPConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _v4_connect


class _V4Handler(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_V4HTTPS, req)

    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_V4HTTP, req)


_v4 = urllib.request.build_opener(_V4Handler())
# once the normal route has failed and IPv4 worked, later calls go straight to IPv4 (no wait)
_prefer_v4 = False


def fetch(request: Union[str, urllib.request.Request], timeout: float = 5.0) -> bytes:
    """The response body. Tries the normal route briefly, then IPv4 only with the full timeout."""
    global _prefer_v4
    if not _prefer_v4:
        try:
            with urllib.request.urlopen(request, timeout=min(timeout, 2.5)) as resp:
                return resp.read()
        except urllib.error.HTTPError:
            raise  # the server answered: the route is fine
        except (OSError, urllib.error.URLError):
            pass
    with _v4.open(request, timeout=timeout) as resp:
        body = resp.read()
    _prefer_v4 = True
    return body
