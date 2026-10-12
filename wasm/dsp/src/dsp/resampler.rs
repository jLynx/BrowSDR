// ============================================================================
// Polyphase Rational Resampler (matches SDR++ dsp/multirate/polyphase_resampler.h)
// ============================================================================

/// Polyphase rational resampler for f32 mono audio data.
/// Resamples by interp/decim ratio using a polyphase filter bank.
pub(crate) struct PolyphaseResamplerF32 {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    buffer: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerF32 {
    pub(crate) fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buffer = vec![0.0f32; taps_per_phase - 1 + 65536];
        PolyphaseResamplerF32 {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer,
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    pub(crate) fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        let count = input.len();
        // Grow buffer dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer.len() {
            self.buffer.resize(needed, 0.0);
        }
        // Copy input into delay line
        self.buffer[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(input);

        while self.offset < count {
            // Dot product with current phase taps
            let phase_taps = &self.phases[self.phase];
            let mut sum = 0.0f32;
            let window = &self.buffer[self.offset..self.offset + self.taps_per_phase];
            for (&sample, &tap) in window.iter().zip(phase_taps) {
                sum += sample * tap;
            }
            output.push(sum);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        // Move delay line (memmove equivalent)
        self.buffer.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    pub(crate) fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}

/// Polyphase rational resampler for complex IQ data.
/// Each complex sample is two f32 (I, Q) interleaved.
pub(crate) struct PolyphaseResamplerComplex {
    interp: usize,
    decim: usize,
    taps_per_phase: usize,
    phases: Vec<Vec<f32>>,
    buffer_i: Vec<f32>,
    buffer_q: Vec<f32>,
    buf_start_offset: usize,
    phase: usize,
    offset: usize,
}

impl PolyphaseResamplerComplex {
    pub(crate) fn new(interp: usize, decim: usize, taps: &[f32]) -> Self {
        let phase_count = interp;
        let taps_per_phase = (taps.len() + phase_count - 1) / phase_count;
        let mut phases = vec![vec![0.0f32; taps_per_phase]; phase_count];

        let tot_tap_count = phase_count * taps_per_phase;
        for i in 0..tot_tap_count {
            let phase_idx = (phase_count - 1) - (i % phase_count);
            let tap_idx = i / phase_count;
            phases[phase_idx][tap_idx] = if i < taps.len() { taps[i] } else { 0.0 };
        }

        let buf_size = taps_per_phase - 1 + 262144;
        PolyphaseResamplerComplex {
            interp,
            decim,
            taps_per_phase,
            phases,
            buffer_i: vec![0.0f32; buf_size],
            buffer_q: vec![0.0f32; buf_size],
            buf_start_offset: taps_per_phase - 1,
            phase: 0,
            offset: 0,
        }
    }

    /// Process `count` complex samples from separate I/Q arrays.
    /// Output is appended to out_i and out_q.
    pub(crate) fn process(&mut self, in_i: &[f32], in_q: &[f32], out_i: &mut Vec<f32>, out_q: &mut Vec<f32>) {
        let count = in_i.len();
        debug_assert_eq!(in_i.len(), in_q.len());

        // Grow buffers dynamically if input exceeds pre-allocated size
        let needed = self.buf_start_offset + count;
        if needed > self.buffer_i.len() {
            self.buffer_i.resize(needed, 0.0);
            self.buffer_q.resize(needed, 0.0);
        }

        self.buffer_i[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_i);
        self.buffer_q[self.buf_start_offset..self.buf_start_offset + count]
            .copy_from_slice(in_q);

        while self.offset < count {
            let phase_taps = &self.phases[self.phase];
            let mut sum_i = 0.0f32;
            let mut sum_q = 0.0f32;
            let end = self.offset + self.taps_per_phase;
            let window_i = &self.buffer_i[self.offset..end];
            let window_q = &self.buffer_q[self.offset..end];
            for ((&i, &q), &tap) in window_i.iter().zip(window_q).zip(phase_taps) {
                sum_i += i * tap;
                sum_q += q * tap;
            }
            out_i.push(sum_i);
            out_q.push(sum_q);

            self.phase += self.decim;
            self.offset += self.phase / self.interp;
            self.phase %= self.interp;
        }
        self.offset -= count;

        self.buffer_i.copy_within(count..count + self.taps_per_phase - 1, 0);
        self.buffer_q.copy_within(count..count + self.taps_per_phase - 1, 0);
    }

    pub(crate) fn reset(&mut self) {
        self.buffer_i.fill(0.0);
        self.buffer_q.fill(0.0);
        self.phase = 0;
        self.offset = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_and_complex_convolution_match_scalar_reference() {
        let input: Vec<f32> = (0..2049).map(|i| (i as f32 * 0.19).sin()).collect();
        let taps: Vec<f32> = (0..157).map(|i| (i as f32 * 0.07).cos() / 157.0).collect();
        for (interp, decim) in [(1, 1), (4, 5), (25, 24), (24, 125), (125, 192)] {
            let mut mono = PolyphaseResamplerF32::new(interp, decim, &taps);
            let mut complex = PolyphaseResamplerComplex::new(interp, decim, &taps);
            let mut actual = Vec::new();
            let mut actual_i = Vec::new();
            let mut actual_q = Vec::new();
            let mut start = 0;
            for count in [1, 17, 653, 2, 997, 379] {
                let chunk = &input[start..start + count];
                mono.process(chunk, &mut actual);
                complex.process(chunk, chunk, &mut actual_i, &mut actual_q);
                start += count;
            }
            let mut expected = Vec::new();
            let mut phase = 0;
            let mut position = 0;
            while position < input.len() {
                let mut sum = 0.0f32;
                for j in 0..mono.taps_per_phase {
                    let index = position as isize + j as isize - (mono.taps_per_phase - 1) as isize;
                    let sample = if index >= 0 { input[index as usize] } else { 0.0 };
                    let tap_index = j * interp + interp - 1 - phase;
                    let tap = taps.get(tap_index).copied().unwrap_or(0.0);
                    sum += sample * tap;
                }
                expected.push(sum);
                phase += decim;
                position += phase / interp;
                phase %= interp;
            }
            assert_eq!(actual, expected, "mono {interp}/{decim}");
            assert_eq!(actual_i, expected, "I {interp}/{decim}");
            assert_eq!(actual_q, expected, "Q {interp}/{decim}");
            mono.reset();
            complex.reset();
            actual.clear(); actual_i.clear(); actual_q.clear();
            mono.process(&input, &mut actual);
            complex.process(&input, &input, &mut actual_i, &mut actual_q);
            assert_eq!(actual, expected);
            assert_eq!(actual_i, expected);
            assert_eq!(actual_q, expected);
        }
    }
}
