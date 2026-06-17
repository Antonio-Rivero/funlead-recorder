"use client";

import { useEffect, useState } from "react";

// Lists the available mics/cameras and lets the owner pick one. Asks for the
// matching permission first so device labels are populated.
interface DeviceSelectorProps {
  kind: "audioinput" | "videoinput";
  label: string;
  value: string;
  onChange: (deviceId: string) => void;
}

export function DeviceSelector({ kind, label, value, onChange }: DeviceSelectorProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let active = true;
    async function loadDevices() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          kind === "audioinput" ? { audio: true } : { video: true },
        );
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Permission denied — devices will show without labels.
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const filtered = all.filter((d) => d.kind === kind);
      if (!active) return;
      setDevices(filtered);
      if (filtered.length > 0 && !value && filtered[0]) onChange(filtered[0].deviceId);
    }
    void loadDevices();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--primary)]/50"
      >
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label ||
              `${kind === "audioinput" ? "Microphone" : "Camera"} ${device.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>
    </div>
  );
}
