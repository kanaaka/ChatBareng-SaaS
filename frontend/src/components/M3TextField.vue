<template>
  <!--
    v0.9.0-r2 (audit fix #1) — M3OutlinedTextField dengan FLOATING label.
    Label rest: tengah field; saat focus / ada isi: float ke notch di atas stroke
    (M3 spec: label memotong border, warna primary saat fokus).
    Placeholder kosong (" ") HANYA trigger CSS :not(:placeholder-shown) —
    TIDAK pernah tampil sebagai placeholder-only.
    Slot "leading" (opsional): ikon kiri. v-model standar Vue.
  -->
  <div class="m3-text-field" :class="{ 'm3-text-field--with-leading': !!$slots.leading }">
    <span v-if="$slots.leading" class="m3-text-field__leading" aria-hidden="true">
      <!-- @slot Ikon kiri opsional (svg) -->
      <slot name="leading" />
    </span>
    <input
      :id="inputId"
      class="m3-text-field__input"
      :type="type"
      :value="modelValue"
      :autocomplete="autocomplete"
      :minlength="minlength"
      :maxlength="maxlength"
      :min="min"
      :max="max"
      :required="required"
      :disabled="disabled"
      placeholder=" "
      :aria-label="label"
      @input="$emit('update:modelValue', $event.target.value)"
    />
    <label class="m3-text-field__label" :for="inputId">{{ label }}</label>
  </div>
</template>

<script setup>
// v0.9.0-r2 — komponen text field outlined M3 (spec §4 "Text field (outlined)",
// revisi round 2 audit visual: floating label WAJIB, bukan placeholder-only).
defineOptions({ inheritAttrs: false })

const props = defineProps({
  /** Label mengambang (wajib — dipakai juga sebagai aria-label) */
  label: { type: String, required: true },
  modelValue: { type: [String, Number], default: '' },
  type: { type: String, default: 'text' },
  autocomplete: { type: String, default: undefined },
  minlength: { type: [String, Number], default: undefined },
  maxlength: { type: [String, Number], default: undefined },
  min: { type: [String, Number], default: undefined },
  max: { type: [String, Number], default: undefined },
  required: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})

defineEmits(['update:modelValue'])

// ID unik per instance utk pairing label↔input (aksesibilitas).
// Counter module-level: aman utk Vue 3.4 (useId() baru ada di 3.5).
let uidCounter = 0
const inputId = `m3tf-${++uidCounter}-${Math.random().toString(36).slice(2, 7)}`
</script>