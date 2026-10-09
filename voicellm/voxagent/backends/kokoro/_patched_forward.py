"""
Bucketed decoder forward pass for Kokoro.

Extracted so the worker process imports it cleanly.
Must run inside torch.no_grad() — without it autograd stores all
intermediates and VRAM balloons from ~0.5GB to ~14GB.
"""

import torch


def make_patched_forward(device, buckets):
    """Return a patched forward_with_tokens bound to device + bucket list."""

    def patched_forward_with_tokens(self, input_ids, ref_s, speed=1):
        with torch.no_grad():
            input_lengths = torch.LongTensor([input_ids.shape[1]]).to(device)
            text_mask = torch.arange(input_lengths.max()).unsqueeze(0).expand(
                input_lengths.shape[0], -1).type_as(input_lengths)
            text_mask = torch.gt(text_mask + 1, input_lengths.unsqueeze(1)).to(device)

            bert_dur = self.bert(input_ids, attention_mask=(~text_mask).int())
            d_en = self.bert_encoder(bert_dur).transpose(-1, -2)
            s = ref_s[:, 128:]
            d = self.predictor.text_encoder(d_en, s, input_lengths, text_mask)
            x, _ = self.predictor.lstm(d)
            duration = self.predictor.duration_proj(x)
            duration = torch.sigmoid(duration).sum(axis=-1) / speed
            pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
            # Chunk-0 space padding: those trailing pad phonemes get clamp(min=1)
            # duration, render as murmur, and then actual_total counts them as real.
            # Zero them so they emit no audio. Encoder length / bucket shape are
            # unchanged, so synth time and warmup shapes are unaffected.
            n_pad = getattr(self, "_n_pad_phonemes", 0)
            if n_pad > 0:
                hi = pred_dur.shape[0] - 1        # spare the trailing boundary token
                lo = max(0, hi - n_pad)
                pred_dur[lo:hi] = 0
                self._n_pad_phonemes = 0          # one-shot; don't leak to next call

            actual_total = pred_dur.sum().item()
            target_total = actual_total
            for b in buckets:
                if b >= actual_total:
                    target_total = b
                    break

            n_phonemes = input_ids.shape[1]
            indices = torch.repeat_interleave(
                torch.arange(n_phonemes, device=device), pred_dur)
            pred_aln_trg = torch.zeros((n_phonemes, target_total), device=device)
            pred_aln_trg[indices, torch.arange(len(indices), device=device)] = 1
            pred_aln_trg = pred_aln_trg.unsqueeze(0)

            en = d.transpose(-1, -2) @ pred_aln_trg
            F0_pred, N_pred = self.predictor.F0Ntrain(en, s)
            t_en = self.text_encoder(input_ids, input_lengths, text_mask)
            asr = t_en @ pred_aln_trg
            audio = self.decoder(asr, F0_pred, N_pred, ref_s[:, :128]).squeeze()

            if target_total > actual_total and audio.numel() > 0:
                DECODER_RF_FRAMES = 8
                safe_frames = max(int(actual_total * 0.85), actual_total - DECODER_RF_FRAMES)
                actual_audio_len = int(audio.shape[-1] * safe_frames / target_total)
                actual_audio_len = max(1, actual_audio_len)
                audio = audio[..., :actual_audio_len]
                fade_len = min(360, audio.shape[-1] // 4)
                if fade_len > 1:
                    fade = torch.linspace(1.0, 0.0, fade_len, device=audio.device)
                    audio[..., -fade_len:] = audio[..., -fade_len:] * fade

            return audio, pred_dur

    return patched_forward_with_tokens
