import { Rows3 } from "lucide-react";
import { apiPatch } from "../../api/client";

interface Props {
  density: "comfortable" | "default" | "compact";
  rowHeight: number;
  columnWidth: number;
}

const presets = {
  comfortable: { rowHeight: 48, columnWidth: 156 },
  default: { rowHeight: 40, columnWidth: 132 },
  compact: { rowHeight: 32, columnWidth: 112 }
} as const;

export function DensityControls({ density }: Props) {
  async function save(nextDensity: keyof typeof presets) {
    const preset = presets[nextDensity];
    await apiPatch("/api/settings", {
      density: nextDensity,
      rowHeight: preset.rowHeight,
      columnWidth: preset.columnWidth
    });
    window.location.reload();
  }

  return (
    <section className="tool-panel">
      <h2>
        <Rows3 size={16} />
        간격
      </h2>
      <div className="segmented">
        {Object.keys(presets).map((preset) => (
          <button
            className={preset === density ? "active" : ""}
            key={preset}
            type="button"
            onClick={() => void save(preset as keyof typeof presets)}
          >
            {preset === "comfortable" ? "편안하게" : preset === "default" ? "기본" : "조밀하게"}
          </button>
        ))}
      </div>
    </section>
  );
}
