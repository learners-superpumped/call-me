"""Tests for AudioRecorder."""

import struct
from pathlib import Path

from callme.recorder import WAV_HEADER_SIZE, AudioRecorder, _wav_header


def test_wav_header_format():
    """WAV header has correct RIFF structure and PCM16 8kHz mono format."""
    header = _wav_header(1000)
    assert len(header) == WAV_HEADER_SIZE

    # RIFF chunk
    assert header[:4] == b"RIFF"
    file_size = struct.unpack_from("<I", header, 4)[0]
    assert file_size == 36 + 1000  # header - 8 + data

    # WAVE + fmt
    assert header[8:12] == b"WAVE"
    assert header[12:16] == b"fmt "
    fmt_size, audio_fmt, channels, sample_rate = struct.unpack_from("<IHHI", header, 16)
    assert fmt_size == 16
    assert audio_fmt == 1  # PCM
    assert channels == 1
    assert sample_rate == 8000

    # data chunk
    assert header[36:40] == b"data"
    data_size = struct.unpack_from("<I", header, 40)[0]
    assert data_size == 1000
