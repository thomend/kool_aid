import type { GraphMeta, LayoutMeta } from "../api";
import { formatLength } from "../format";
import { CloseIcon } from "./Icons";

interface Props {
  meta: GraphMeta;
  /** Set while the cost-space view is active. */
  layout: LayoutMeta | null;
  onClose: () => void;
}

export function InfoPopup({ meta, layout, onClose }: Props) {
  return (
    <section className="info-popup glass" role="dialog" aria-label="About this map">
      <button className="icon-button close" aria-label="Close" onClick={onClose}>
        <CloseIcon />
      </button>
      <h3>About this map</h3>
      <p className="small">
        Walking cost is length stretched by heat stress (PET) and slope, so hot, shadeless or
        steep streets cost more to walk than cool, flat ones. Edges are coloured by cost per
        metre compared with a typical metre of Basel without trees, fountains and slope: red
        streets are harder to walk than that, teal ones easier.
      </p>
      <p className="small">
        Heat only counts above 29 °C PET, where moderate heat stress begins, and then grows
        quadratically. <strong>Heat sensitivity</strong> sets how steeply: <em>low</em> for fit
        adults on short trips, <em>high</em> for elderly people, small children or anyone with a
        heart condition.
      </p>
      <p className="small">
        <strong>Tree shade</strong> softens the heat: the part of a street under a public tree's
        crown counts only half of its extra heat cost. <strong>Fountains</strong> offer a drink
        and a cool-down: within 100 m of one, a street loses a fifth of its extra heat cost.
        <strong>Slope</strong> makes you slower (uphill and downhill alike: +19 % at 5 %, +42 % at
        10 %), and so longer in the heat; it counts double for <em>high</em> and half for{" "}
        <em>low</em> sensitivity. Switch any factor off under <em>Count in</em> to see what it
        changes: colours and the cost space are always measured against Basel without trees,
        fountains and slope.
      </p>
      {layout ? (
        <CostSpaceNote layout={layout} />
      ) : (
        <p className="footnote">
          {meta.component_count - 1} small disconnected pieces are shown faded. Zoom in to see
          intersections.
        </p>
      )}
    </section>
  );
}

function CostSpaceNote({ layout }: { layout: LayoutMeta }) {
  const times = (v: number) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`;
  return (
    <>
      <p className="section-label">Cost space</p>
      <p className="small">
        Basel as it feels on a hot afternoon: every neighbourhood grows by how much harder it is to
        walk than a typical metre without trees, fountains and slope, and shrinks where it is easier. The
        grid is warped along with the city and tinted in the colours of the streets, so big red
        cells are heat-stressed areas and small teal cells cool ones.
      </p>
      <p className="small subtle">
        The effect is exaggerated to make it visible (area grows with the cost per metre to the
        power of {layout.exaggeration}), so compare areas with each other, not with distances.
      </p>
      <dl className="mini-stats">
        <div>
          <dt>250 m blocks</dt>
          <dd>
            {times(layout.area_ratio_p01)} – {times(layout.area_ratio_p99)}
          </dd>
        </div>
        <div>
          <dt>Largest shift</dt>
          <dd>{formatLength(layout.displacement_max_m)}</dd>
        </div>
      </dl>
      <p className="footnote">Only the connected main network is shown.</p>
    </>
  );
}
