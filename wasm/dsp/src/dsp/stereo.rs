//! Broadcast FM stereo recovery, following SDR++ BroadcastFM's pilot PLL
//! and matched multiplex delay. FIR taps here run newest-to-oldest, so the
//! complex pilot taps use the opposite sign to SDR++'s forward dot product.
use std::f32::consts::PI;
use super::filter::RealFIR;
use super::primitives::{estimate_tap_count, nuttall_window, sinc};

pub(crate) struct StereoDecoder {
    pilot_i: RealFIR,
    pilot_q: RealFIR,
    delay: Vec<f32>,
    position: usize,
    phase: f32,
    frequency: f32,
    alpha: f32,
    beta: f32,
    rate: f32,
    pilot_level: f32,
    coherence: f32,
    blend: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::primitives::low_pass_taps;

    fn decode(left_only: bool, pilot: bool, chunks: usize) -> (Vec<f32>, Vec<f32>) {
        let rate = 250000.0;
        let input: Vec<f32> = (0..125000).map(|k| {
            let time = k as f32 / rate;
            let tone = 0.2 * (2.0 * PI * 1000.0 * time).sin();
            let sum = tone * 0.5;
            let difference = if left_only { sum } else { -sum };
            // FM stereo's pilot is sine; the difference subcarrier is cosine.
            sum + difference * (2.0 * PI * 38000.0 * time + 0.74).cos()
                + if pilot { 0.1 * (2.0 * PI * 19000.0 * time + 0.37).sin() } else { 0.0 }
        }).collect();
        let mut decoder = StereoDecoder::new(rate);
        let mut l = Vec::new(); let mut r = Vec::new();
        let mut all_l = Vec::new(); let mut all_r = Vec::new();
        for block in input.chunks(chunks) {
            decoder.process(block, &mut l, &mut r);
            all_l.extend_from_slice(&l); all_r.extend_from_slice(&r);
        }
        let taps = low_pass_taps(15000.0, 4000.0, rate as f64);
        let mut left = vec![0.0; all_l.len()];
        let mut right = vec![0.0; all_r.len()];
        RealFIR::new(taps.clone()).process_block(&all_l, &mut left);
        RealFIR::new(taps).process_block(&all_r, &mut right);
        (left, right)
    }

    fn rms(input: &[f32]) -> f32 {
        (input.iter().map(|x| x * x).sum::<f32>() / input.len() as f32).sqrt()
    }

    #[test]
    fn stereo_separates_left_and_right_with_pilot_phase_offset() {
        for left_only in [true, false] {
            let (l, r) = decode(left_only, true, 997);
            let l = rms(&l[100000..]); let r = rms(&r[100000..]);
            let (wanted, leakage) = if left_only { (l, r) } else { (r, l) };
            assert!(wanted > 0.1, "wanted={wanted} leakage={leakage}");
            assert!(leakage / wanted < 0.025, "wanted={wanted} leakage={leakage}");
        }
    }

    #[test]
    fn absent_pilot_produces_mono_and_chunk_boundaries_preserve_phase() {
        let (l, r) = decode(true, false, 997);
        assert!(l.iter().zip(r.iter()).all(|(l,r)| (l-r).abs() < 1e-6));
        let (split, _) = decode(true, true, 997);
        let (whole, _) = decode(true, true, 125000);
        assert_eq!(split, whole);
    }

    #[test]
    fn pilot_loss_blends_to_mono_and_reset_restarts_acquisition() {
        let mut decoder = StereoDecoder::new(250000.0);
        let mut left = Vec::new(); let mut right = Vec::new();
        let pilot: Vec<f32> = (0..75000).map(|k| 0.1 *
            (2.0 * PI * 19000.0 * k as f32 / 250000.0).sin()).collect();
        decoder.process(&pilot, &mut left, &mut right);
        assert!(decoder.blend > 0.98);
        decoder.process(&vec![0.0; 75000], &mut left, &mut right);
        assert!(decoder.blend < 0.001);
        decoder.reset();
        assert_eq!(decoder.blend, 0.0);
        assert_eq!(decoder.pilot_level, 0.0);
    }

    #[test]
    fn broadband_noise_does_not_enable_stereo() {
        let mut seed = 42_u32;
        let noise: Vec<f32> = (0..125000).map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed as f64 / u32::MAX as f64 - 0.5) as f32 * 0.8
        }).collect();
        let mut decoder = StereoDecoder::new(250000.0);
        let mut left = Vec::new(); let mut right = Vec::new();
        decoder.process(&noise, &mut left, &mut right);
        assert!(decoder.blend < 0.01, "noise stereo blend={}", decoder.blend);
    }
}

impl StereoDecoder {
    pub(crate) fn new(rate: f32) -> Self {
        let count = estimate_tap_count(3000.0, rate as f64) | 1;
        let half = count as f64 / 2.0;
        let omega = 2.0 * std::f64::consts::PI * 250.0 / rate as f64;
        let center = 2.0 * std::f64::consts::PI * 19000.0 / rate as f64;
        let mut real = Vec::with_capacity(count);
        let mut imag = Vec::with_capacity(count);
        for i in 0..count {
            let t = i as f64 - half + 0.5;
            let tap = sinc(t * omega) * nuttall_window(t - half, count as f64)
                * omega / std::f64::consts::PI;
            real.push((tap * (center * t).cos()) as f32);
            imag.push((tap * (center * t).sin()) as f32);
        }
        let bandwidth = 25000.0 / rate;
        let damping = 2.0_f32.sqrt() / 2.0;
        let denominator = 1.0 + 2.0 * damping * bandwidth + bandwidth * bandwidth;
        Self {
            pilot_i: RealFIR::new(real), pilot_q: RealFIR::new(imag),
            // With a causal newest-first FIR the pilot delay is exactly the
            // group delay; the PLL emits its current phase before advancing.
            delay: vec![0.0; (count - 1) / 2], position: 0,
            phase: 0.0, frequency: 2.0 * PI * 19000.0 / rate,
            alpha: 4.0 * damping * bandwidth / denominator,
            beta: 4.0 * bandwidth * bandwidth / denominator,
            rate, pilot_level: 0.0, coherence: 0.0, blend: 0.0,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.pilot_i.reset(); self.pilot_q.reset();
        self.delay.fill(0.0); self.position = 0;
        self.phase = 0.0; self.frequency = 2.0 * PI * 19000.0 / self.rate;
        self.pilot_level = 0.0; self.coherence = 0.0; self.blend = 0.0;
    }

    pub(crate) fn process(&mut self, mpx: &[f32], left: &mut Vec<f32>, right: &mut Vec<f32>) {
        left.resize(mpx.len(), 0.0); right.resize(mpx.len(), 0.0);
        // Reuse the output buffers for pilot filtering, then replace each value
        // with reconstructed audio once the corresponding pilot was consumed.
        self.pilot_i.process_block(mpx, left);
        self.pilot_q.process_block(mpx, right);
        let meter = 1.0 / (self.rate * 0.02);
        for k in 0..mpx.len() {
            let amplitude = 2.0 * left[k].hypot(right[k]);
            let mut error = right[k].atan2(left[k]) - self.phase;
            if error > PI { error -= 2.0 * PI; }
            else if error < -PI { error += 2.0 * PI; }
            self.pilot_level += meter * (amplitude - self.pilot_level);
            self.coherence += meter * (error.cos() - self.coherence);
            // Do not turn uncorrelated noise at 38 kHz into stereo hiss.
            let target = if self.pilot_level > 0.015 && self.coherence > 0.95 { 1.0 } else { 0.0 };
            let time = if target > self.blend { 0.05 } else { 0.02 };
            self.blend += (target - self.blend) / (self.rate * time);
            let sum = self.delay[self.position];
            self.delay[self.position] = mpx[k];
            self.position = (self.position + 1) % self.delay.len();
            // The analytic phase of a sine pilot is theta - pi/2. Negating
            // cos(2*phase) restores the cosine 38 kHz subcarrier reference.
            let difference = -2.0 * sum * (2.0 * self.phase).cos() * self.blend;
            left[k] = sum + difference;
            right[k] = sum - difference;
            self.frequency = (self.frequency + self.beta * error)
                .clamp(2.0 * PI * 18750.0 / self.rate, 2.0 * PI * 19250.0 / self.rate);
            self.phase += self.frequency + self.alpha * error;
            if self.phase > PI { self.phase -= 2.0 * PI; }
            else if self.phase < -PI { self.phase += 2.0 * PI; }
        }
    }
}
