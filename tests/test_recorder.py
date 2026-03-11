"""Tests for AudioRecorder."""

import struct
from pathlib import Path

from callme.recorder import WAV_HEADER_SIZE, AudioRecorder, _wav_header, _mix_samples


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


import wave


def test_start_creates_three_wav_files(tmp_path):
    """start() creates in.wav, out.wav, mix.wav with valid WAV headers."""
    rec = AudioRecorder(tmp_path, "test_call")
    rec.start()
    rec.stop()

    for name in ("in.wav", "out.wav", "mix.wav"):
        f = tmp_path / "test_call" / name
        assert f.exists()
        with wave.open(str(f), "rb") as w:
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 8000


def test_write_inbound_only(tmp_path):
    """Inbound-only recording produces valid WAV with correct data size."""
    rec = AudioRecorder(tmp_path, "call_in")
    rec.start()

    # 160 samples = 320 bytes PCM16 (20ms at 8kHz)
    pcm16 = b"\x01\x00" * 160
    rec.write_inbound(pcm16)
    rec.write_inbound(pcm16)
    rec.stop()

    with wave.open(str(tmp_path / "call_in" / "in.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())
        # At least 640 bytes of actual audio data
        assert len(frames) >= 640


def test_write_outbound_only(tmp_path):
    """Outbound-only recording produces valid WAV with correct data size."""
    rec = AudioRecorder(tmp_path, "call_out")
    rec.start()

    pcm16 = b"\x02\x00" * 160
    rec.write_outbound(pcm16)
    rec.stop()

    with wave.open(str(tmp_path / "call_out" / "out.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())
        assert len(frames) >= 320


def test_stop_equalizes_track_lengths(tmp_path):
    """stop() pads all three files to the same length."""
    rec = AudioRecorder(tmp_path, "call_eq")
    rec.start()

    rec.write_inbound(b"\x01\x00" * 160)
    rec.write_inbound(b"\x01\x00" * 160)
    rec.write_outbound(b"\x02\x00" * 80)
    rec.stop()

    lengths = []
    for name in ("in.wav", "out.wav", "mix.wav"):
        with wave.open(str(tmp_path / "call_eq" / name), "rb") as w:
            lengths.append(w.getnframes())

    # All three files must have the same frame count
    assert lengths[0] == lengths[1] == lengths[2]


def test_write_before_start_is_noop():
    """Writing before start() does not raise."""
    rec = AudioRecorder("/tmp", "no_start")
    rec.write_inbound(b"\x00" * 320)
    rec.write_outbound(b"\x00" * 320)
    # No exception = pass


def test_mix_samples_basic():
    """_mix_samples adds PCM16 samples correctly."""
    a = struct.pack("<2h", 100, 200)
    b = struct.pack("<2h", 50, -100)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<2h", result)
    assert mixed == (150, 100)


def test_mix_samples_clipping():
    """_mix_samples clamps to int16 range."""
    a = struct.pack("<h", 32000)
    b = struct.pack("<h", 32000)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<h", result)
    assert mixed[0] == 32767  # clamped

    a = struct.pack("<h", -32000)
    b = struct.pack("<h", -32000)
    result = _mix_samples(a, b)
    mixed = struct.unpack("<h", result)
    assert mixed[0] == -32768  # clamped


def test_mix_file_contains_both_tracks(tmp_path):
    """mix.wav contains data from both inbound and outbound."""
    rec = AudioRecorder(tmp_path, "call_mix")
    rec.start()

    # Write inbound and outbound simultaneously (same wall-clock moment)
    in_data = struct.pack("<4h", 1000, 2000, 3000, 4000)
    out_data = struct.pack("<4h", 500, 500, 500, 500)
    rec.write_inbound(in_data)
    rec.write_outbound(out_data)
    rec.stop()

    with wave.open(str(tmp_path / "call_mix" / "mix.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())

    # The mix should exist and have frames
    assert len(frames) > 0

    # Since both writes happen at nearly the same wall-clock time,
    # outbound overlaps inbound → mix should contain summed samples
    samples = struct.unpack(f"<{len(frames)//2}h", frames)
    # First 4 samples should be sum: (1500, 2500, 3500, 4500)
    assert samples[0] == 1500
    assert samples[1] == 2500
    assert samples[2] == 3500
    assert samples[3] == 4500


def test_zero_length_call(tmp_path):
    """start() immediately followed by stop() produces valid empty WAV files."""
    rec = AudioRecorder(tmp_path, "empty_call")
    rec.start()
    rec.stop()

    for name in ("in.wav", "out.wav", "mix.wav"):
        with wave.open(str(tmp_path / "empty_call" / name), "rb") as w:
            assert w.getnframes() == 0
            assert w.getnchannels() == 1
            assert w.getsampwidth() == 2
            assert w.getframerate() == 8000


def test_wall_clock_gap_inserts_silence(tmp_path):
    """Wall-clock gap between writes produces silence padding."""
    from unittest.mock import patch

    rec = AudioRecorder(tmp_path, "gap_call")

    # Mock time.monotonic:
    #   start()             → 0.0 (sets _start_time)
    #   first write_inbound → 0.0 (_expected_bytes: elapsed=0.0, expected=0)
    #   second write_inbound→ 1.0 (_expected_bytes: elapsed=1.0, expected=16000)
    times = iter([0.0, 0.0, 1.0])
    with patch("callme.recorder.time") as mock_time:
        mock_time.monotonic = lambda: next(times)

        rec.start()  # consumes 0.0
        pcm16 = struct.pack("<4h", 100, 200, 300, 400)  # 8 bytes
        rec.write_inbound(pcm16)  # consumes 0.0 → expected=0, no padding
        rec.write_inbound(pcm16)  # consumes 1.0 → expected=16000, pads gap

    rec.stop()

    with wave.open(str(tmp_path / "gap_call" / "in.wav"), "rb") as w:
        frames = w.readframes(w.getnframes())

    # Total should be: 8 bytes (first) + gap silence + 8 bytes (second)
    # Gap = 16000 - 8 = 15992 bytes of silence
    # Total data in file >= 16000 bytes
    assert len(frames) >= 16000
