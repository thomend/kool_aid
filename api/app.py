from db import get_connection
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

app = FastAPI(title="Mock FastAPI App - Hackaton")


@app.get("/api/streets")
async def list_streets(limit: int = 50):
    """Roundtrip: query pedestrian_streets in DuckDB, return as JSON."""
    con = get_connection()
    rows = con.execute(
        "SELECT name, highway_types, segment_count FROM pedestrian_streets "
        "ORDER BY name LIMIT ?",
        [limit],
    ).fetchall()
    con.close()
    return [
        {"name": name, "highway_types": highway_types, "segment_count": segment_count}
        for name, highway_types, segment_count in rows
    ]


@app.get("/api/streets/{name}")
async def get_street(name: str):
    """Roundtrip: fetch a single named street, including its geometry (WKT)."""
    con = get_connection()
    row = con.execute(
        "SELECT name, highway_types, segment_count, wkt FROM pedestrian_streets WHERE name = ?",
        [name],
    ).fetchone()
    con.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Street '{name}' not found")
    name, highway_types, segment_count, wkt = row
    return {"name": name, "highway_types": highway_types, "segment_count": segment_count, "wkt": wkt}


@app.get("/", response_class=HTMLResponse)
async def root():
    return """
<h1>Mock FastAPI App</h1>
<p>Visit <a href='/docs'>/docs</a> UI.</p>
<h2>Pedestrian streets (from DuckDB)</h2>
<table id="streets" border="1" cellpadding="4">
  <thead><tr><th>Name</th><th>Highway types</th><th>Segments</th></tr></thead>
  <tbody></tbody>
</table>
<script>
  fetch('/api/streets?limit=20')
    .then(r => r.json())
    .then(streets => {
      const body = document.querySelector('#streets tbody');
      streets.forEach(s => {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${s.name}</td><td>${s.highway_types}</td><td>${s.segment_count}</td>`;
        body.appendChild(row);
      });
    });
</script>
"""