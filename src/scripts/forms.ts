export function nameError(value: string, optional = false): string {
  if (!optional && !value.trim()) return 'Enter your display name.';
  return value.trim().length > 40 ? 'Use 40 characters or fewer.' : '';
}

export function validateNames(form: HTMLFormElement): boolean {
  let first: HTMLInputElement | undefined;
  for (const input of form.querySelectorAll<HTMLInputElement>('[data-name]')) {
    const message = nameError(input.value, !input.required);
    document.getElementById(`${input.id}-error`)!.textContent = message;
    input.setAttribute('aria-invalid', String(Boolean(message)));
    if (message) first ??= input;
  }
  first?.focus();
  return !first;
}
