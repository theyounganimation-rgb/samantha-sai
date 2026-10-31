// Restore the original context fields. Moving every plugin's full system
// context into appendContext overflowed the native per-turn reference budget
// in ordinary use. Keep all original evidence and policy in their existing
// channels; warm-session optimization must wait for an aggregate budget design.
export function stableForegroundContext(_ctx, legacy, _policy = '') {
  return legacy;
}
