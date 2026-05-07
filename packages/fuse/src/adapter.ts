import type { LlmFuseRuntime } from "@llm-fuse/core";

/**
 * Builds a fuse-native handlers object from an LlmFuseRuntime.
 *
 * fuse-native is loaded dynamically so that environments without it (or without
 * libfuse / macFUSE on the host) can still import this package without crashing.
 *
 * Usage (when fuse-native + a kernel that supports FUSE are available):
 *
 *   import Fuse from "fuse-native";
 *   import { buildFuseHandlers } from "@llm-fuse/fuse";
 *   const fuse = new Fuse(mountPoint, buildFuseHandlers(runtime), { displayFolder: true });
 *   fuse.mount(err => ...);
 */
export interface FuseHandlers {
  readdir(path: string, cb: (errno: number, names?: string[]) => void): void;
  getattr(path: string, cb: (errno: number, stat?: FuseStat) => void): void;
  open(path: string, flags: number, cb: (errno: number, fd?: number) => void): void;
  read(
    path: string,
    fd: number,
    buf: Buffer,
    len: number,
    pos: number,
    cb: (bytesRead: number) => void,
  ): void;
}

export interface FuseStat {
  mtime: Date;
  atime: Date;
  ctime: Date;
  size: number;
  mode: number;
  uid: number;
  gid: number;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export function buildFuseHandlers(runtime: LlmFuseRuntime): FuseHandlers {
  const fileCache = new Map<string, Buffer>();

  return {
    readdir(path, cb) {
      runtime
        .list(path)
        .then((entries) => cb(0, entries.map((e) => e.name)))
        .catch(() => cb(-2));
    },
    getattr(path, cb) {
      runtime
        .stat(path)
        .then((node) => {
          const isDir = node.kind === "dir";
          const now = new Date();
          cb(0, {
            mtime: now,
            atime: now,
            ctime: now,
            size: node.size ?? (isDir ? 4096 : 8192),
            mode: (isDir ? S_IFDIR | 0o555 : S_IFREG | 0o444),
            uid: process.getuid?.() ?? 0,
            gid: process.getgid?.() ?? 0,
          });
        })
        .catch(() => cb(-2));
    },
    open(_path, _flags, cb) {
      cb(0, 42);
    },
    read(path, _fd, buf, len, pos, cb) {
      const cached = fileCache.get(path);
      const respond = (data: Buffer) => {
        const slice = data.subarray(pos, pos + len);
        slice.copy(buf);
        cb(slice.length);
      };
      if (cached) return respond(cached);
      runtime
        .read(path)
        .then((res) => {
          const data = Buffer.from(res.body, "utf8");
          fileCache.set(path, data);
          respond(data);
        })
        .catch(() => cb(0));
    },
  };
}
