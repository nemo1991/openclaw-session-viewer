import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import "./ThinkingBlock.css";

interface Props {
  text: string;
}

export function ThinkingBlock({ text }: Props) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
  return (
    <details className="thinking-block" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} /> 思考
        {!open && <span className="thinking-preview"> {preview}</span>}
      </summary>
      <div className="thinking-content">{text}</div>
    </details>
  );
}
