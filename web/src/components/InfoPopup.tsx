import type { CostModel, GraphMeta, LayoutMeta } from "../api";
import { NO_FACTORS, costFactor } from "../costModel";
import { PROFILES } from "../profiles";
import { CloseIcon } from "./Icons";

interface Props {
  meta: GraphMeta;
  /** Set while the cost-space view is active. */
  layout: LayoutMeta | null;
  onClose: () => void;
}

const times = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1).replace(/\.0$/, "")}×`;

export function InfoPopup({ meta, layout, onClose }: Props) {
  const model = meta.cost_model;
  return (
    <section className="info-popup glass" role="dialog" aria-label="About this map">
      <button className="icon-button close" aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
      <h3>About this map</h3>
      <p className="small">
        Walking cost is the length of a street, made longer by heat (PET above 29 °C) and slope,
        and shorter by tree shade and fountains.
      </p>

      <p className="section-label">Colours</p>
      <p className="small">
        Cost per metre, compared with a typical metre without trees, fountains and slope:{" "}
        <strong>red</strong> is harder, <strong>teal</strong> easier.
      </p>

      <p className="section-label">Heat sensitivity</p>
      <p className="small">
        How strongly heat counts. <em>High</em> stands for elderly people, small children and
        heart conditions.{model && <> {sunnyStreet(model)}</>}
      </p>

      <p className="section-label">Count in</p>
      <ul className="info-list small">
        <li>
          <strong>Tree shade</strong> halves the heat cost under a crown.
        </li>
        <li>
          <strong>Fountains</strong> take 20 % off the heat cost within 100 m.
        </li>
        <li>
          <strong>Slope</strong> adds walking time: +19 % at 5 %, +42 % at 10 % (half on low,
          double on high).
        </li>
      </ul>

      <p className="section-label">Compare routes</p>
      <p className="small">The shortest and the coolest walk between two points.</p>

      {layout ? (
        <CostSpaceNote layout={layout} />
      ) : (
        <p className="footnote">
          Faded: {meta.component_count - 1} disconnected pieces. Zoom in for intersections and
          factor icons.
        </p>
      )}
    </section>
  );
}

/** "A sunny, flat street at 41 °C PET costs 1.6× / 2× / 3.3× its length (low / medium / high)." */
function sunnyStreet(model: CostModel): string {
  const excess = (41 - model.pet_threshold_c) ** 2;
  const factors = PROFILES.map(({ key }) => costFactor(model, key, NO_FACTORS, excess, 0, 0, 0));
  return `A sunny, flat street at 41 °C PET costs ${factors.map(times).join(" / ")} its length (low / medium / high).`;
}

function CostSpaceNote({ layout }: { layout: LayoutMeta }) {
  return (
    <>
      <p className="section-label">Cost space</p>
      <ul className="info-list small">
        <li>
          A tile <strong>grows</strong> where walking is harder than typical and turns red.
        </li>
        <li>
          It <strong>shrinks</strong> where walking is easier and turns teal.
        </li>
        <li>
          Exaggerated to be visible (area ∝ cost<sup>{layout.exaggeration}</sup>): compare tiles with
          each other, not distances.
        </li>
      </ul>
    </>
  );
}
