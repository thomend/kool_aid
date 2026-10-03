interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  hint?: string;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}

export function SegmentedControl<T extends string>({ options, value, onChange, label }: Props<T>) {
  const index = options.findIndex((o) => o.value === value);
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      style={{ "--count": options.length, "--index": index } as React.CSSProperties}
    >
      {/* no thumb when nothing matches, e.g. custom cost settings */}
      {index >= 0 && <span className="segmented-thumb" aria-hidden />}
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          title={o.hint}
          className={o.value === value ? "active" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.hint && o.disabled && <span className="badge">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}
