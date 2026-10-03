"""Diffusion cartogram (Gastner & Newman 2004, PNAS 101:7499) on a regular grid.

Deforms the plane so that every region's area becomes proportional to a target
density: where the density is above the mean the plane expands, below it
contracts. The deformation is the flow of a diffusing density, so it is smooth
and never folds: lines that don't cross on the map don't cross afterwards.

Works in grid units (one cell = `cell_m` metres) on a periodic FFT grid, so the
density grid needs a generous margin of neutral density (1) around the data.
The result is a warp: the displaced position of every grid node, from which
any point is moved by bilinear interpolation (`Warp.apply`).
"""

from dataclasses import dataclass

import numpy as np


@dataclass
class Warp:
    """Displaced positions of a regular lattice, in metres."""

    x0: float  # metres of lattice node (0, 0)
    y0: float
    step_m: float
    moved: np.ndarray  # (nx, ny, 2) displaced lattice node positions in metres

    def apply(self, points):
        """Move points (n, 2, metres) by bilinear interpolation of the lattice."""
        nx, ny = self.moved.shape[:2]
        gx = np.clip((points[:, 0] - self.x0) / self.step_m, 0, nx - 1.000001)
        gy = np.clip((points[:, 1] - self.y0) / self.step_m, 0, ny - 1.000001)
        i, j = gx.astype(int), gy.astype(int)
        fx, fy = (gx - i)[:, None], (gy - j)[:, None]
        m = self.moved
        return (
            m[i, j] * (1 - fx) * (1 - fy)
            + m[i + 1, j] * fx * (1 - fy)
            + m[i, j + 1] * (1 - fx) * fy
            + m[i + 1, j + 1] * fx * fy
        )


def diffuse(density, max_steps=2000, tol=1e-4):
    """Final positions (in grid units) of all grid nodes under the diffusion flow.

    density is an (L, L) array of target densities (L a power of two works
    best); node (i, j) starts at (i, j) and moves with v = -grad(rho) / rho
    while rho diffuses towards its mean.
    """
    size = density.shape[0]
    rho_hat = np.fft.fft2(density)
    k = 2 * np.pi * np.fft.fftfreq(size)
    kx, ky = np.meshgrid(k, k, indexing="ij")
    k2 = kx**2 + ky**2

    def velocity(t, pts):
        decay = rho_hat * np.exp(-k2 * t)
        rho = np.fft.ifft2(decay).real
        vx = -np.fft.ifft2(1j * kx * decay).real / rho
        vy = -np.fft.ifft2(1j * ky * decay).real / rho
        return np.column_stack([_sample(vx, pts), _sample(vy, pts)])

    i, j = np.meshgrid(np.arange(size + 1), np.arange(size + 1), indexing="ij")
    pts = np.column_stack([i.ravel(), j.ravel()]).astype(float)
    t, dt = 0.0, 1e-2
    # rho is uniform (to ~1e-3) once its longest wavelength has decayed
    t_end = np.log(1e3) / (2 * np.pi / size) ** 2
    for _ in range(max_steps):
        v = velocity(t, pts)
        speed = np.abs(v).max()
        dt = min(dt * 2, 0.2 / max(speed, 1e-12), t_end - t)  # < 0.2 cells per step
        mid = pts + 0.5 * dt * v  # midpoint (RK2) step
        pts = pts + dt * velocity(t + 0.5 * dt, mid)
        t += dt
        if t >= t_end or speed * dt < tol:
            break
    return pts.reshape(size + 1, size + 1, 2)


def _sample(field, pts):
    """Bilinear sample of a periodic grid field at (n, 2) grid coordinates."""
    size = field.shape[0]
    i0 = np.floor(pts[:, 0]).astype(int)
    j0 = np.floor(pts[:, 1]).astype(int)
    fx, fy = pts[:, 0] - i0, pts[:, 1] - j0
    i0, j0 = i0 % size, j0 % size
    i1, j1 = (i0 + 1) % size, (j0 + 1) % size
    return (
        field[i0, j0] * (1 - fx) * (1 - fy)
        + field[i1, j0] * fx * (1 - fy)
        + field[i0, j1] * (1 - fx) * fy
        + field[i1, j1] * fx * fy
    )


def gaussian_blur(grid, sigma_cells):
    """Periodic Gaussian blur via FFT."""
    size = grid.shape[0]
    k = 2 * np.pi * np.fft.fftfreq(size)
    kx, ky = np.meshgrid(k, k, indexing="ij")
    kernel = np.exp(-0.5 * (kx**2 + ky**2) * sigma_cells**2)
    return np.fft.ifft2(np.fft.fft2(grid) * kernel).real
