# IQ recording

Open **Tools → IQ Recorder** while receiving with a locally connected SDR to
record the full received band before demodulation. Choose a duration in Seconds
or Minutes, then select **Start recording**. Use these recordings to analyse
signals, explore modulation, or demodulate and decode them in compatible
software. Remote clients cannot capture IQ.

The recording contains signed, interleaved 8-bit I/Q samples (`ci8`), with I first
and Q second, at the receiver's sample rate. No additional decimation is applied.
Download the matching `.sigmf-data` and `.sigmf-meta` files and keep their base
names identical. Metadata includes the sample rate, hardware centre frequency,
frequency shift, capture time, gains, and missing USB samples when available.

Captures up to 64 MiB stay in memory for download. Larger captures open a save
dialog in Chrome or Edge and stream directly to disk; download the matching
metadata after recording finishes. At 2 MSPS, 15 minutes produces 3.6 GB of IQ
data. A lower receiver sample rate reduces both file size and captured bandwidth.
Keep the tab open and ensure the disk has enough space and sustained write speed.

Capture buffers are copied before USB reuse. File writes use a queue bounded to
64 MiB; a disk that cannot keep up causes the capture to fail. Retuning, changing
gains, restarting or stopping reception, disconnecting, or cancelling interrupts
the capture. Incomplete file captures are aborted. Automatic gain adjustment
must be stopped before capturing.

The completion message and metadata report device USB sample loss when the
receiver provides continuity statistics. These statistics do not measure audio
playback gaps or guarantee a gap-free RF recording.

The recorder tests use simulated IQ and file sinks, including long captures,
exact sample boundaries, reused input buffers, cancellation, write failures,
timeouts, and slow disks. They require no hardware or private RF recordings.
