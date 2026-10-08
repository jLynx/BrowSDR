use std::f32::consts::PI;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const FFT_SIZE: usize = 8192;

#[wasm_bindgen]
pub struct SharedChannelizer {
    ratio: usize,
    overlap: usize,
    hop: usize,
    centers: Vec<usize>,
    pending: Vec<Complex<f32>>,
    history: Vec<Complex<f32>>,
    spectrum: Vec<Complex<f32>>,
    filter: Vec<(usize, Complex<f32>)>,
    band: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    ifft_scratch: Vec<Complex<f32>>,
    fft: Arc<dyn Fft<f32>>,
    ifft: Arc<dyn Fft<f32>>,
    outputs: Vec<Vec<f32>>,
    batch_samples: usize,
    output_ready: bool,
}

#[wasm_bindgen]
impl SharedChannelizer {
    #[wasm_bindgen(constructor)]
    pub fn new(ratio: usize, centers: &[i32]) -> Self {
        assert!(ratio >= 2 && ratio <= 32 && ratio.is_power_of_two());
        assert!(centers.iter().all(|center| *center % (FFT_SIZE / (ratio * 2)) as i32 == 0));
        let overlap = ratio * 64;
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let ifft = planner.plan_fft_inverse(FFT_SIZE / ratio);
        let mut filter = vec![Complex::new(0.0, 0.0); FFT_SIZE];
        let cutoff = 0.425 / ratio as f32;
        let mut sum = 0.0;
        for index in 0..=overlap {
            let position = index as f32 - overlap as f32 / 2.0;
            let sinc = if position == 0.0 { 2.0 * cutoff } else {
                (2.0 * PI * cutoff * position).sin() / (PI * position)
            };
            let phase = 2.0 * PI * index as f32 / overlap as f32;
            let window = 0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos();
            filter[index].re = sinc * window;
            sum += filter[index].re;
        }
        for value in &mut filter { value.re /= sum; }
        fft.process(&mut filter);
        let filter = filter.into_iter().enumerate().filter(|(_, value)| value.norm_sqr() > 1e-12).collect();
        let fft_scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        let ifft_scratch = vec![Complex::new(0.0, 0.0); ifft.get_inplace_scratch_len()];
        Self {
            ratio, overlap, hop: FFT_SIZE - overlap,
            centers: centers.iter().map(|center| center.rem_euclid(FFT_SIZE as i32) as usize).collect(),
            pending: Vec::new(), history: vec![Complex::new(0.0, 0.0); overlap],
            spectrum: vec![Complex::new(0.0, 0.0); FFT_SIZE], filter,
            band: vec![Complex::new(0.0, 0.0); FFT_SIZE / ratio],
            fft_scratch, ifft_scratch, fft, ifft,
            outputs: centers.iter().map(|_| Vec::new()).collect(),
            batch_samples: 0, output_ready: false,
        }
    }

    pub fn process(&mut self, input: &[i8]) {
        if self.output_ready { for output in &mut self.outputs { output.clear(); } }
        self.output_ready = false;
        self.pending.extend(input.chunks_exact(2).map(|pair| Complex::new(pair[0] as f32 / 128.0, pair[1] as f32 / 128.0)));
        let mut consumed = 0;
        while self.pending.len() - consumed >= self.hop {
            self.spectrum[..self.overlap].copy_from_slice(&self.history);
            self.spectrum[self.overlap..].copy_from_slice(&self.pending[consumed..consumed + self.hop]);
            self.history.copy_from_slice(&self.spectrum[FFT_SIZE - self.overlap..]);
            self.fft.process_with_scratch(&mut self.spectrum, &mut self.fft_scratch);
            let band_size = self.band.len();
            for (center, output) in self.centers.iter().zip(&mut self.outputs) {
                self.band.fill(Complex::new(0.0, 0.0));
                for &(index, coefficient) in &self.filter {
                    self.band[index & (band_size - 1)] += self.spectrum[(index + center) & (FFT_SIZE - 1)] * coefficient;
                }
                self.ifft.process_with_scratch(&mut self.band, &mut self.ifft_scratch);
                for value in &self.band[self.overlap / self.ratio..] {
                    output.push(value.re / FFT_SIZE as f32);
                    output.push(value.im / FFT_SIZE as f32);
                }
            }
            consumed += self.hop;
        }
        if consumed > 0 { self.pending.drain(..consumed); }
        self.output_ready = self.outputs.first().is_some_and(|output| !output.is_empty() && output.len() / 2 >= self.batch_samples);
    }

    pub fn set_batch_samples(&mut self, count: usize) { self.batch_samples = count; }
    pub fn output_ptr(&self, band: usize) -> *const f32 { self.outputs[band].as_ptr() }
    pub fn output_len(&self, band: usize) -> usize { if self.output_ready { self.outputs[band].len() } else { 0 } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(count: usize, bin: f32) -> Vec<i8> {
        (0..count).flat_map(|index| {
            let phase = 2.0 * PI * bin * index as f32 / FFT_SIZE as f32;
            [(phase.cos() * 100.0) as i8, (phase.sin() * 100.0) as i8]
        }).collect()
    }

    #[test]
    fn preserves_tone_frequency_and_rejects_aliases() {
        for ratio in [2, 4, 8, 16, 32] {
            let center = FFT_SIZE as i32 / (ratio * 2) as i32;
            let band_size = FFT_SIZE / ratio;
            let mut channelizer = SharedChannelizer::new(ratio, &[center]);
            channelizer.process(&tone(FFT_SIZE * 4, center as f32 + band_size as f32 * 0.2));
            let output = &channelizer.outputs[0];
            let pairs: Vec<_> = output.chunks_exact(2).skip(128).map(|pair| Complex::new(pair[0], pair[1])).collect();
            let amplitude = pairs.iter().map(|value| value.norm()).sum::<f32>() / pairs.len() as f32;
            assert!((amplitude - 100.0 / 128.0).abs() < 0.02);
            let rotation = pairs.windows(2).map(|pair| (pair[1] * pair[0].conj()).arg()).sum::<f32>() / (pairs.len() - 1) as f32;
            assert!((rotation - 0.4 * PI).abs() < 0.01);
            channelizer.process(&tone(FFT_SIZE * 4, center as f32 + band_size as f32 * 0.8));
            let rejected = channelizer.outputs[0].iter().skip(band_size * 4).map(|value| value * value).sum::<f32>();
            assert!(rejected / (channelizer.outputs[0].len() as f32) < 0.00001);
        }
    }

    #[test]
    fn matches_contiguous_input_across_odd_sized_transfers() {
        let input = tone(FFT_SIZE * 5, -97.0);
        let mut contiguous = SharedChannelizer::new(32, &[-128, 256]);
        contiguous.process(&input);
        let mut split = SharedChannelizer::new(32, &[-128, 256]);
        let mut outputs = [Vec::new(), Vec::new()];
        for chunk in input.chunks(1026) {
            split.process(chunk);
            for (index, output) in outputs.iter_mut().enumerate() { output.extend_from_slice(&split.outputs[index]); }
        }
        assert_eq!(outputs[0], contiguous.outputs[0]);
        assert_eq!(outputs[1], contiguous.outputs[1]);
    }

    #[test]
    fn batching_preserves_samples_and_bounds_output() {
        let input = tone(FFT_SIZE * 20, -97.0);
        let mut contiguous = SharedChannelizer::new(32, &[-128]);
        contiguous.process(&input);
        let mut batched = SharedChannelizer::new(32, &[-128]);
        batched.set_batch_samples(512);
        let mut output = Vec::new();
        for chunk in input.chunks(1026) {
            batched.process(chunk);
            let length = batched.output_len(0);
            if length > 0 {
                assert!(length >= 1024 && length <= 1408);
                output.extend_from_slice(&batched.outputs[0]);
            }
        }
        if !batched.output_ready { output.extend_from_slice(&batched.outputs[0]); }
        assert_eq!(output, contiguous.outputs[0]);
    }

    #[test]
    fn simultaneous_positive_and_negative_bands_remain_independent() {
        let input: Vec<i8> = (0..FFT_SIZE * 8).flat_map(|index| {
            let first = 2.0 * PI * -110.0 * index as f32 / FFT_SIZE as f32;
            let second = 2.0 * PI * 299.0 * index as f32 / FFT_SIZE as f32;
            [((first.cos() + second.cos()) * 45.0) as i8, ((first.sin() + second.sin()) * 45.0) as i8]
        }).collect();
        let mut channelizer = SharedChannelizer::new(32, &[-128, 256]);
        channelizer.process(&input);
        for (index, expected_bin) in [18.0, 43.0].iter().enumerate() {
            let pairs: Vec<_> = channelizer.outputs[index].chunks_exact(2).skip(256).map(|pair| Complex::new(pair[0], pair[1])).collect();
            let rotation = pairs.windows(2).map(|pair| (pair[1] * pair[0].conj()).arg()).sum::<f32>() / (pairs.len() - 1) as f32;
            assert!((rotation - 2.0 * PI * expected_bin / 256.0).abs() < 0.01);
            let amplitude = pairs.iter().map(|value| value.norm()).sum::<f32>() / pairs.len() as f32;
            assert!((amplitude - 45.0 / 128.0).abs() < 0.02);
        }
    }
}
