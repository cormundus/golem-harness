"""Greenhouse vault blueprint — parametric arch for Aria's world-in-miniature.

Footprint: x29-51 (23 wide), z-165..-139 (27 long), footer at y72.
Walls: glass panes y73..77 (5 courses, /walls job).
Vault: arch spanning x, ridge running N-S (along z), apex y84 (= 12 above ground y72).

Computes: arch shell cells (glass blocks, one per x per slice, stepped),
gable fill cells at both z ends (panes), material budget, placement manifest,
and a clean SVG cross-section for Adam (one slice, low visual density).
"""
import json, math

X0, X1 = 29, 51          # inclusive span, 23 wide
Z0, Z1 = -165, -139      # inclusive span, 27 long
Y_WALL_TOP = 77          # top pane course of the straight walls
Y_APEX = 84              # ridge height (12 above ground y72)
CX = (X0 + X1) / 2       # 40.0 — ridge line

def arch_y(x):
    """Parabolic arch: wall-top at the eaves, apex at the ridge."""
    half = (X1 - X0) / 2                       # 11
    t = (x - CX) / half                        # -1..1
    return Y_WALL_TOP + (Y_APEX - Y_WALL_TOP) * (1 - t * t)

# one slice: for each x column, the roof cell is at round(arch_y)
slice_cells = []
for x in range(X0, X1 + 1):
    y = round(arch_y(x))
    slice_cells.append((x, y))

# dedupe check + step profile
ys = [y for _, y in slice_cells]
n_slices = Z1 - Z0 + 1

# gable fill (both z ends): cells strictly between wall top and arch underside
gable = []
for x in range(X0 + 1, X1):                    # corners belong to walls
    top = round(arch_y(x))
    for y in range(Y_WALL_TOP + 1, top):
        gable.append((x, y))

arch_blocks = len(slice_cells) * n_slices      # glass blocks
gable_panes = len(gable) * 2                   # panes at both ends
wall_panes  = (2 * (23 + 27) - 4 - 4) * 5 - 2  # perimeter minus corners, 5 courses, minus door

print(f"arch cells per slice : {len(slice_cells)}  (profile y: {min(ys)}..{max(ys)})")
print(f"slices (z)           : {n_slices}")
print(f"ARCH glass blocks    : {arch_blocks}")
print(f"gable fill cells/end : {len(gable)}  -> panes both ends: {gable_panes}")
print(f"wall panes (5 courses): {wall_panes}")
print()
g_for_panes = math.ceil((wall_panes + gable_panes) / 16) * 6
print(f"glass needed: {arch_blocks} blocks + {g_for_panes} for panes "
      f"= {arch_blocks + g_for_panes} total glass -> sand equivalent same")

# manifest: arch shell, laid ridge-outward per slice
manifest = []
for z in range(Z0, Z1 + 1):
    for x, y in slice_cells:
        manifest.append({"x": x, "y": y, "z": z, "block": "glass"})
with open("vault_manifest.json", "w") as f:
    json.dump(manifest, f)
print(f"manifest: {len(manifest)} placements -> vault_manifest.json")

# ---- SVG cross-section (one slice, clean: grid, wall lines, arch cells) ----
S = 16                                          # px per block
W = (X1 - X0 + 3) * S
H = (Y_APEX - 70 + 3) * S
def px(x): return (x - X0 + 1) * S
def py(y): return H - (y - 70 + 1) * S
cells_svg = "\n".join(
    f'<rect x="{px(x)}" y="{py(y)}" width="{S-1}" height="{S-1}" fill="#7ec8e3" stroke="#3a7ca5"/>'
    for x, y in slice_cells)
wall_svg = "\n".join(
    f'<rect x="{px(x)}" y="{py(y)}" width="{S-1}" height="{S-1}" fill="#bde0fe" stroke="#7aa5c9"/>'
    for x in (X0, X1) for y in range(73, Y_WALL_TOP + 1))
footer_svg = "\n".join(
    f'<rect x="{px(x)}" y="{py(72)}" width="{S-1}" height="{S-1}" fill="#5a5a66" stroke="#3c3c44"/>'
    for x in range(X0, X1 + 1))
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<rect width="{W}" height="{H}" fill="#fbf8f1"/>
{footer_svg}
{wall_svg}
{cells_svg}
<text x="{px(40)}" y="{py(Y_APEX)-6}" font-family="monospace" font-size="12" text-anchor="middle" fill="#333">ridge y{Y_APEX} (12 up)</text>
<text x="{px(40)}" y="{py(70)+14}" font-family="monospace" font-size="12" text-anchor="middle" fill="#333">23 wide (x29-51) - cross-section, one z-slice</text>
</svg>'''
with open("vault_slice.svg", "w") as f:
    f.write(svg)
print("cross-section -> vault_slice.svg")
