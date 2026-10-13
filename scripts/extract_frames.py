# 从录屏抽帧（调试用）。
#
# 需要 ffmpeg：优先用环境变量 IMAGEIO_FFMPEG_EXE，其次找 PATH 里的 ffmpeg。
# 本机没装 ffmpeg 时，可以从清华 PyPI 的 imageio-ffmpeg wheel 里解一个出来
# （wheel 就是 zip，解压后 binaries/ 目录里有 ffmpeg 可执行文件）。
#
# 用法: python extract_frames.py <视频> <起始秒> <输出png>
import os
import shutil
import subprocess
import sys


def find_ffmpeg() -> str | None:
    env = os.environ.get("IMAGEIO_FFMPEG_EXE")
    if env and os.path.exists(env):
        return env
    return shutil.which("ffmpeg")


if __name__ == "__main__":
    ff = find_ffmpeg()
    if not ff:
        sys.exit("找不到 ffmpeg：请装一个，或设置 IMAGEIO_FFMPEG_EXE 指向可执行文件")
    video, t, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    r = subprocess.run(
        [ff, "-v", "error", "-ss", t, "-i", video, "-frames:v", "1", "-q:v", "2", out],
        capture_output=True,
    )
    print("ok" if r.returncode == 0 else r.stderr.decode("utf-8", "ignore")[:300])
