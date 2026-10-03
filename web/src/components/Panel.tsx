import { BookIcon, WalkIcon } from "./Icons";

interface Props {
  onOpenGlossary: () => void;
}

export function Panel({ onOpenGlossary }: Props) {
  return (
    <aside className="panel glass">
      <header className="panel-header">
        <div className="app-icon">
          <WalkIcon />
        </div>
        <div className="panel-title">
          <h1>Walkable Basel</h1>
          <p className="subtle">Pedestrian network graph</p>
        </div>
        <button
          className="icon-button glossary-button"
          onClick={onOpenGlossary}
          aria-label="Open glossary"
          title="Glossary"
        >
          <BookIcon />
        </button>
      </header>
    </aside>
  );
}
