interface Props {
  value: number;
  onChange: (value: number) => void;
}

// Scrubs the morph between geographic positions (0) and cost-space positions (1).
export function MorphSlider({ value, onChange }: Props) {
  return (
    <div className="morph glass">
      <span className={value < 0.5 ? "active" : undefined}>Geography</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={value}
        aria-label="Morph between geography and cost space"
        style={{ "--fill": `${value * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={value >= 0.5 ? "active" : undefined}>Cost space</span>
    </div>
  );
}
