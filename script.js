let rowCount = 0;

// API key is entered in the app and kept in localStorage
const API_KEY_STORAGE_KEY = 'sigint-triangulation-api-key';

function loadApiKey() {
    try {
        return localStorage.getItem(API_KEY_STORAGE_KEY) || '';
    } catch (error) {
        console.warn('Could not load API key:', error);
        return '';
    }
}

let key = loadApiKey();

function cartoUrl() {
    return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' + (key ? '?key=' + encodeURIComponent(key) : '');
}

// Initialize Leaflet map with dark theme
const darkMap = L.tileLayer(cartoUrl(), {
    attribution: '©OpenStreetMap, ©CartoDB',
    maxZoom: 19
});

// Initialize map centered on Bucharest, Romania
const START_COORDS = [46.84061,6.91782]; // Coordinates for Bucharest
const START_ZOOM = 12; // Appropriate zoom level for city view

const map = L.map('map', {
    layers: [darkMap],
    center: START_COORDS,
    zoom: START_ZOOM
});

// swisstopo maps from geo.admin.ch (Web Mercator WMTS, Switzerland and Liechtenstein only)
function swisstopoLayer(layerId, maxNativeZoom) {
    return L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layerId}/default/current/3857/{z}/{x}/{y}.jpeg`, {
        attribution: '©swisstopo',
        maxNativeZoom,
        maxZoom: 19
    });
}

const baseLayers = {
    'CARTO': darkMap,
    'swisstopo Map': swisstopoLayer('ch.swisstopo.pixelkarte-farbe', 18),
    'swisstopo Map (grey)': swisstopoLayer('ch.swisstopo.pixelkarte-grau', 18),
    'swisstopo Aerial': swisstopoLayer('ch.swisstopo.swissimage', 19)
};
let activeBaseLayer = 'CARTO';

L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', e => {
    activeBaseLayer = e.name;
    saveState();
});

// Separate layer groups so POIs and measurements survive re-triangulation
const vectorLayer = L.layerGroup().addTo(map); // receivers and bearing lines, drawn live
const resultsLayer = L.layerGroup().addTo(map); // triangulated target
const poiLayer = L.layerGroup().addTo(map);
const measureLayer = L.layerGroup().addTo(map);

let targetLocation = null;
let triangulatedGeometry = null; // vectors the current target was computed from
let pois = [];
let poiCount = 0;
let activeTool = null; // 'poi' | 'measure' | null
let currentMeasure = null;
let measurements = []; // point arrays, one per measurement path
let restoring = false; // suppresses saving while restoring saved state

// Icons as SVG path data so the map (SVG) and the image export (canvas Path2D) draw
// the same shapes. 'color' is replaced with the marker's colour.
const OUTLINE = 'rgba(15, 17, 23, 0.85)';

const RX_TOWER = 'M14 11 L8.5 33 M14 11 L19.5 33 M10.25 26 L17.75 26 M12 19 L16 19 M6 33 L22 33';
const RX_WAVES = 'M17.54 5.46 A5 5 0 0 1 17.54 12.54 M10.46 5.46 A5 5 0 0 0 10.46 12.54 ' +
    'M20.36 2.64 A9 9 0 0 1 20.36 15.36 M7.64 2.64 A9 9 0 0 0 7.64 15.36';
const RX_ICON = {
    size: [28, 36],
    anchor: [14, 34], // foot of the mast
    parts: [
        { d: RX_TOWER + ' ' + RX_WAVES, stroke: OUTLINE, width: 4.5 },
        { d: RX_TOWER + ' ' + RX_WAVES, stroke: 'color', width: 2 },
        { d: 'M11.6 9 a2.4 2.4 0 1 0 4.8 0 a2.4 2.4 0 1 0 -4.8 0', fill: 'color', stroke: OUTLINE, width: 1.5 }
    ]
};

const TARGET_RING = 'M12 24 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0';
const TARGET_TICKS = 'M24 1 L24 9 M24 39 L24 47 M1 24 L9 24 M39 24 L47 24';
const TARGET_ICON = {
    size: [48, 48],
    anchor: [24, 24],
    parts: [
        { d: 'M4 24 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0', fill: 'rgba(255, 59, 59, 0.18)' },
        { d: TARGET_RING + ' ' + TARGET_TICKS, stroke: OUTLINE, width: 5 },
        { d: TARGET_RING + ' ' + TARGET_TICKS, stroke: 'color', width: 2.5 },
        { d: 'M20.5 24 a3.5 3.5 0 1 0 7 0 a3.5 3.5 0 1 0 -7 0', fill: 'color', stroke: OUTLINE, width: 1.5 }
    ]
};

function iconSvg(icon, color) {
    const [w, h] = icon.size;
    const paths = icon.parts.map(part => {
        const fill = part.fill ? (part.fill === 'color' ? color : part.fill) : 'none';
        const stroke = part.stroke ? `stroke="${part.stroke === 'color' ? color : part.stroke}" stroke-width="${part.width}"` : '';
        return `<path d="${part.d}" fill="${fill}" ${stroke} stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join('');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function rxIcon(name, color) {
    return L.divIcon({
        className: 'rx-marker',
        html: `${iconSvg(RX_ICON, color)}<span class="map-label" style="color: ${color}; border-color: ${color};">${escapeHtml(name)}</span>`,
        iconSize: RX_ICON.size,
        iconAnchor: RX_ICON.anchor
    });
}

// Custom icon for intersection point
const targetIcon = L.divIcon({
    className: 'custom-target-marker',
    html: `<div class="target-pulse">${iconSvg(TARGET_ICON, '#ff3b3b')}</div><span class="map-label target-label">TARGET</span>`,
    iconSize: TARGET_ICON.size,
    iconAnchor: TARGET_ICON.anchor
});

// Add a new row
function addRow(values = {}) {
    const tableBody = document.getElementById('input-rows');
    rowCount++;
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input type="text" name="name-${rowCount}" placeholder="RX ${rowCount} (optional)"></td>
        <td><input type="text" name="position-${rowCount}" placeholder="Lat,Lng" required></td>
        <td><input type="text" name="bearing-${rowCount}" inputmode="decimal" placeholder="45 or 40-55" required></td>
        <td><input type="number" name="freq-${rowCount}" step="0.001" placeholder="MHz" required></td>
        <td><input type="number" name="signal-${rowCount}" step="0.1" placeholder="dB" required></td>
        <td><button type="button" class="danger" onclick="removeRow(this)">Remove</button></td>
    `;
    ['name', 'position', 'bearing', 'freq', 'signal'].forEach(field => {
        if (values[field] !== undefined) rowField(row, field).value = values[field];
    });
    tableBody.appendChild(row);
    drawVectors();
    saveState();
}

// Get a row's input by field (name, position, bearing, freq, signal)
function rowField(row, field) {
    return row.querySelector(`input[name^="${field}-"]`);
}

// Remove a specific row
function removeRow(button) {
    const row = button.parentNode.parentNode;
    row.remove();
    drawVectors();
    saveState();
}

// Process the input data
function processData() {
    const loadingSpinner = document.getElementById('process-loading');
    loadingSpinner.style.display = 'inline-block';

    const rows = document.querySelectorAll('#input-rows tr');
    if (rows.length < 2) {
        alert('At least two signal sources are required for triangulation.');
        loadingSpinner.style.display = 'none';
        return;
    }

    try {
        const data = Array.from(rows).map(row => {
            const d = readRow(row);
            if (!d.position) {
                throw new Error('Invalid coordinates format. Use Lat,Lng format with valid ranges.');
            }
            if (!isValidBearing(d.bearing)) {
                throw new Error('Bearing must be a number from 0 to 360, or a range like 40-55.');
            }
            return d;
        });

        setTimeout(() => {
            calculateIntersection(data);
            loadingSpinner.style.display = 'none';
            document.getElementById('confidence-level').style.display = 'block';
        }, 500);
    } catch (error) {
        alert(error.message);
        loadingSpinner.style.display = 'none';
    }
}

function readRow(row) {
    return {
        name: rowField(row, 'name').value.trim(),
        position: parseCoords(rowField(row, 'position').value),
        ...parseBearing(rowField(row, 'bearing').value),
        frequency: parseFloat(rowField(row, 'freq').value),
        signal: parseFloat(rowField(row, 'signal').value)
    };
}

function isValidBearing(bearing) {
    return !isNaN(bearing) && bearing >= 0 && bearing <= 360;
}

// Parse "45" or a range "40-55" (clockwise, so "350-10" spans north) into its centre
// bearing and width in degrees
function parseBearing(text) {
    const match = text.trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
    const invalid = { bearing: NaN, bearingWidth: 0, bearingFrom: NaN };
    if (!match) return invalid;

    const from = parseFloat(match[1]);
    const to = match[2] === undefined ? from : parseFloat(match[2]);
    if (!isValidBearing(from) || !isValidBearing(to)) return invalid;

    const width = (to - from + 360) % 360;
    return { bearing: (from + width / 2) % 360, bearingWidth: width, bearingFrom: from };
}

function formatBearing(d) {
    if (!d.bearingWidth) return `${+d.bearing.toFixed(2)}°`;
    const to = (d.bearingFrom + d.bearingWidth) % 360;
    return `${+d.bearingFrom.toFixed(2)}–${+to.toFixed(2)}° (centre ${+d.bearing.toFixed(2)}°)`;
}

// Draw each receiver and its bearing vector as soon as its row has valid values
function drawVectors() {
    vectorLayer.clearLayers();

    const rows = Array.from(document.querySelectorAll('#input-rows tr'));
    const lines = [];

    rows.forEach((row, index) => {
        const d = readRow(row);
        if (!d.position) return;

        const lineColor = `hsl(${(index * 360) / rows.length}, 100%, 50%)`;
        const hasBearing = isValidBearing(d.bearing);

        if (hasBearing) {
            const lineLength = 50; // km; kept short for cleaner visualization
            if (d.bearingWidth > 0) {
                // Wedge covering the bearing range
                const steps = Math.max(2, Math.ceil(d.bearingWidth / 2));
                const arc = Array.from({ length: steps + 1 }, (_, i) =>
                    destinationPoint(d.position, d.bearingFrom + (d.bearingWidth * i) / steps, lineLength));
                L.polygon([d.position, ...arc], {
                    color: lineColor,
                    weight: 1,
                    opacity: 0.6,
                    fillColor: lineColor,
                    fillOpacity: 0.15
                }).addTo(vectorLayer);
            }
            const endPoint = destinationPoint(d.position, d.bearing, lineLength);
            L.polyline([d.position, endPoint], {
                color: lineColor,
                weight: 2,
                opacity: 0.8,
                dashArray: d.bearingWidth > 0 ? '6 6' : null
            }).addTo(vectorLayer);
            lines.push({
                start: d.position,
                bearing: d.bearing,
                width: d.bearingWidth
            });
        }

        const rxName = d.name || `RX ${index + 1}`;
        L.marker(d.position, {
                icon: rxIcon(rxName, lineColor),
                exportAs: { kind: 'rx', name: rxName, color: lineColor }
            })
            .addTo(vectorLayer)
            .bindPopup(`
            <b>${escapeHtml(d.name || `Signal Source ${index + 1}`)}</b><br>
            Frequency: ${isNaN(d.frequency) ? '—' : d.frequency + ' MHz'}<br>
            Signal Strength: ${isNaN(d.signal) ? '—' : d.signal + ' dB'}<br>
            Bearing: ${hasBearing ? formatBearing(d) : '—'}
        `);
    });

    // A target computed from different vectors is out of date
    if (targetLocation && JSON.stringify(lines) !== triangulatedGeometry) {
        clearTarget();
    }

    return lines;
}

function clearTarget() {
    resultsLayer.clearLayers();
    targetLocation = null;
    triangulatedGeometry = null;
    document.getElementById('result-coords').textContent = 'Coordinates: Awaiting triangulation...';
    document.getElementById('confidence-level').style.display = 'none';
    renderPoiList();
    saveState();
}

// Calculate the intersection of the bearing vectors and mark the target
function calculateIntersection(data, { silent = false } = {}) {
    resultsLayer.clearLayers();
    drawVectors();

    const lines = data.map(d => ({
        start: d.position,
        bearing: d.bearing,
        width: d.bearingWidth
    }));

    const bounds = L.latLngBounds(data.map(d => d.position));

    const intersection = calculateGeodesicIntersection(lines);
    targetLocation = intersection;
    triangulatedGeometry = intersection ? JSON.stringify(lines) : null;
    renderPoiList();
    saveState();
    if (intersection) {
        // Add intersection point to bounds
        bounds.extend(intersection);

        // Add marker for the intersection point
        L.marker(intersection, {
                icon: targetIcon,
                exportAs: { kind: 'target' }
            })
            .addTo(resultsLayer);

        // Update coordinates display
        document.getElementById('result-coords').textContent =
            `Coordinates: ${intersection[0].toFixed(6)}, ${intersection[1].toFixed(6)}`;

        // Add a small padding to the bounds and fit the map to show all points
        map.fitBounds(bounds.pad(0.3));

        updateConfidenceLevel(lines, intersection);
    } else {
        if (!silent) alert(`No intersection found. Check that the bearings converge and are not parallel.`);
        document.getElementById('result-coords').textContent = 'Coordinates: No valid intersection found';
        document.getElementById('confidence-level').style.display = 'none';

        // If no intersection, just fit to measurement points
        map.fitBounds(bounds.pad(0.3));
    }
}

// Calculate the destination point given start point, bearing and distance
function destinationPoint([lat, lng], bearing, distance) {
    const R = 6371; // Earth's radius in km
    const d = distance / R;
    const bearingRad = (bearing * Math.PI) / 180;
    const lat1 = (lat * Math.PI) / 180;
    const lng1 = (lng * Math.PI) / 180;

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad)
    );

    const lng2 = lng1 + Math.atan2(
        Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

    return [
        (lat2 * 180) / Math.PI,
        (lng2 * 180) / Math.PI
    ];
}

// Find geodesic intersection of multiple bearing lines
function calculateGeodesicIntersection(lines) {
    const intersections = [];

    for (let i = 0; i < lines.length - 1; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            const intersection = geodesicIntersection(
                lines[i].start,
                lines[i].bearing,
                lines[j].start,
                lines[j].bearing
            );
            if (intersection) {
                // Crossings of tight bearings count for more than crossings of wide ranges
                intersections.push({
                    point: intersection,
                    weight: 1 / ((1 + lines[i].width) * (1 + lines[j].width))
                });
            }
        }
    }

    if (intersections.length === 0) return null;

    // Calculate weighted center point of all intersections
    const totalWeight = intersections.reduce((sum, x) => sum + x.weight, 0);
    const avgLat = intersections.reduce((sum, x) => sum + x.point[0] * x.weight, 0) / totalWeight;
    const avgLng = intersections.reduce((sum, x) => sum + x.point[1] * x.weight, 0) / totalWeight;

    return [avgLat, avgLng];
}

// Calculate intersection of two geodesics
function geodesicIntersection([lat1, lng1], brng1, [lat2, lng2], brng2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const λ1 = (lng1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const λ2 = (lng2 * Math.PI) / 180;
    const θ13 = (brng1 * Math.PI) / 180;
    const θ23 = (brng2 * Math.PI) / 180;
    const Δφ = φ2 - φ1;
    const Δλ = λ2 - λ1;

    const δ12 = 2 * Math.asin(Math.sqrt(
        Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2)
    ));

    if (Math.abs(δ12) < 1e-10) return null;

    const θa = Math.acos(
        (Math.sin(φ2) - Math.sin(φ1) * Math.cos(δ12)) /
        (Math.sin(δ12) * Math.cos(φ1))
    );

    const θb = Math.acos(
        (Math.sin(φ1) - Math.sin(φ2) * Math.cos(δ12)) /
        (Math.sin(δ12) * Math.cos(φ2))
    );

    const θ12 = Math.sin(λ2 - λ1) > 0 ? θa : 2 * Math.PI - θa;
    const θ21 = Math.sin(λ2 - λ1) > 0 ? 2 * Math.PI - θb : θb;

    const α1 = (θ13 - θ12 + Math.PI) % (2 * Math.PI) - Math.PI;
    const α2 = (θ21 - θ23 + Math.PI) % (2 * Math.PI) - Math.PI;

    if (Math.sin(α1) === 0 && Math.sin(α2) === 0) return null;
    if (Math.sin(α1) * Math.sin(α2) < 0) return null;

    const α3 = Math.acos(
        -Math.cos(α1) * Math.cos(α2) +
        Math.sin(α1) * Math.sin(α2) * Math.cos(δ12)
    );

    const δ13 = Math.atan2(
        Math.sin(δ12) * Math.sin(α1) * Math.sin(α2),
        Math.cos(α2) + Math.cos(α1) * Math.cos(α3)
    );

    const φ3 = Math.asin(
        Math.sin(φ1) * Math.cos(δ13) +
        Math.cos(φ1) * Math.sin(δ13) * Math.cos(θ13)
    );

    const Δλ13 = Math.atan2(
        Math.sin(θ13) * Math.sin(δ13) * Math.cos(φ1),
        Math.cos(δ13) - Math.sin(φ1) * Math.sin(φ3)
    );

    const λ3 = λ1 + Δλ13;

    return [(φ3 * 180) / Math.PI, (λ3 * 180) / Math.PI];
}

// Calculate confidence level based on intersection spread
function updateConfidenceLevel(lines, intersection) {
    const distances = lines.map(line => {
        return calculateDistance(line.start, intersection);
    });

    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
    const spread = Math.max(...distances) - Math.min(...distances);

    const levels = ["Very High", "High", "Medium", "Low"];
    let level;
    if (spread < avgDistance * 0.1) level = 0;
    else if (spread < avgDistance * 0.2) level = 1;
    else if (spread < avgDistance * 0.3) level = 2;
    else level = 3;

    // Wide bearing ranges make the fix less certain
    const avgWidth = lines.reduce((sum, line) => sum + (line.width || 0), 0) / lines.length;
    if (avgWidth >= 30) level += 2;
    else if (avgWidth >= 10) level += 1;
    const confidence = levels[Math.min(level, levels.length - 1)];

    const confidenceElement = document.getElementById('confidence-value');
    confidenceElement.textContent = confidence;

    // Update confidence indicator color
    confidenceElement.style.color =
        confidence === "Very High" ? "#51cf66" :
        confidence === "High" ? "#94d82d" :
        confidence === "Medium" ? "#fcc419" :
        "#fa5252";
}

// Calculate distance between two points in km
function calculateDistance(point1, point2) {
    const [lat1, lon1] = point1;
    const [lat2, lon2] = point2;
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Reset the form, rows, and map
function resetData() {
    document.getElementById('input-rows').innerHTML = '';
    rowCount = 0;

    clearTarget();

    // Reset to Bucharest view instead of world view
    map.setView(START_COORDS, START_ZOOM);
    document.getElementById('result-coords').textContent = 'Coordinates: Awaiting triangulation...';
    document.getElementById('confidence-level').style.display = 'none';

    // Add initial row (also saves the cleared state)
    addRow();
}

// Function to export map as image
async function exportMapImage() {
    const loadingSpinner = document.getElementById('process-loading');
    // leaflet-image can't render HTML markers, so they are lifted off the map during
    // the export and drawn onto the canvas afterwards
    const hidden = [];
    try {
        loadingSpinner.style.display = 'inline-block';

        const lines = [];
        const overlays = [];

        map.eachLayer(layer => {
            if (layer instanceof L.Marker && layer.getIcon() instanceof L.DivIcon) {
                overlays.push({ ...layer.options.exportAs, position: layer.getLatLng() });
                const parent = [vectorLayer, resultsLayer, poiLayer, measureLayer].find(g => g.hasLayer(layer)) || map;
                hidden.push({ parent, layer });
            } else if (layer instanceof L.Polyline) {
                const polygon = layer instanceof L.Polygon;
                lines.push({
                    latlngs: polygon ? layer.getLatLngs()[0] : layer.getLatLngs(),
                    polygon,
                    color: layer.options.color,
                    weight: layer.options.weight,
                    opacity: layer.options.opacity,
                    fillColor: layer.options.fillColor || layer.options.color,
                    fillOpacity: layer.options.fillOpacity,
                    dash: layer.options.dashArray ? layer.options.dashArray.split(' ').map(Number) : []
                });
            }
        });
        hidden.forEach(({ parent, layer }) => parent.removeLayer(layer));

        // Wait for all tiles to load
        await new Promise(resolve => {
            let tilesLoading = false;
            map.eachLayer(layer => {
                if (layer instanceof L.TileLayer) {
                    if (!layer.isLoading()) {
                        resolve();
                    } else {
                        tilesLoading = true;
                        layer.once('load', resolve);
                    }
                }
            });
            if (!tilesLoading) {
                resolve();
            }
        });

        // Use leafletImage with error handling and timeout
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Map export timed out'));
            }, 10000); // 10 second timeout

            leafletImage(map, function(err, canvas) {
                clearTimeout(timeout);

                if (err) {
                    reject(err);
                    return;
                }

                const ctx = canvas.getContext('2d');

                // Redraw the lines and wedges on the canvas, wedges underneath
                lines.sort((a, b) => b.polygon - a.polygon).forEach(line => {
                    const points = line.latlngs.map(latlng => map.latLngToContainerPoint(latlng));
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(points[0].x, points[0].y);
                    points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
                    if (line.polygon) {
                        ctx.closePath();
                        ctx.fillStyle = line.fillColor;
                        ctx.globalAlpha = line.fillOpacity;
                        ctx.fill();
                    }
                    ctx.setLineDash(line.dash);
                    ctx.strokeStyle = line.color;
                    ctx.lineWidth = line.weight;
                    ctx.globalAlpha = line.opacity;
                    ctx.lineCap = 'round';
                    ctx.stroke();
                    ctx.restore();
                });

                // Markers outside the exported frame are skipped, labels included
                const inFrame = ({ x, y }) => x >= 0 && y >= 0 && x <= canvas.width && y <= canvas.height;
                const order = { poi: 0, rx: 1, target: 2 }; // target on top
                overlays
                    .filter(o => o.kind in order)
                    .sort((a, b) => order[a.kind] - order[b.kind])
                    .forEach(o => {
                        const p = map.latLngToContainerPoint(o.position);
                        if (!inFrame(p)) return;
                        if (o.kind === 'rx') drawRxOnCanvas(ctx, p, o.name, o.color);
                        else if (o.kind === 'poi') drawPoiOnCanvas(ctx, p, o.name);
                        else drawTargetOnCanvas(ctx, p);
                    });

                // Convert canvas to blob and download
                canvas.toBlob(function(blob) {
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.download = `triangulation-map-${new Date().toISOString().slice(0,10)}.png`;
                    link.href = url;
                    link.click();

                    // Cleanup
                    URL.revokeObjectURL(url);
                    resolve();
                }, 'image/png');
            });
        });
    } catch (error) {
        console.error('Error exporting map:', error);
        alert('Failed to export map image. Please try again.');
    } finally {
        hidden.forEach(({ parent, layer }) => parent.addLayer(layer));
        loadingSpinner.style.display = 'none';
    }
}

// Draws an SVG-style icon (see RX_ICON / TARGET_ICON) with its anchor at p
function drawIconOnCanvas(ctx, icon, { x, y }, color) {
    ctx.save();
    ctx.translate(x - icon.anchor[0], y - icon.anchor[1]);
    icon.parts.forEach(part => {
        const path = new Path2D(part.d);
        if (part.fill) {
            ctx.fillStyle = part.fill === 'color' ? color : part.fill;
            ctx.fill(path);
        }
        if (part.stroke) {
            ctx.lineWidth = part.width;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = part.stroke === 'color' ? color : part.stroke;
            ctx.stroke(path);
        }
    });
    ctx.restore();
}

// Rounded dark label matching the on-map .map-label style
function drawLabelOnCanvas(ctx, text, x, y, color, align = 'left') {
    ctx.save();
    ctx.font = '600 12px "Roboto Mono", monospace';
    const padX = 6;
    const h = 20;
    const w = ctx.measureText(text).width + padX * 2;
    const left = align === 'center' ? x - w / 2 : x;
    ctx.beginPath();
    ctx.roundRect(left, y - h / 2, w, h, 4);
    ctx.fillStyle = 'rgba(15, 17, 23, 0.85)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + padX, y + 1);
    ctx.restore();
}

function drawRxOnCanvas(ctx, p, name, color) {
    drawIconOnCanvas(ctx, RX_ICON, p, color);
    drawLabelOnCanvas(ctx, name, p.x + 14, p.y - 18, color);
}

function drawPoiOnCanvas(ctx, { x, y }, name) {
    ctx.save();
    ctx.shadowColor = 'rgba(190, 75, 219, 0.8)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#be4bdb';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
    drawLabelOnCanvas(ctx, name, x, y - 20, '#be4bdb', 'center');
}

function drawTargetOnCanvas(ctx, p) {
    drawIconOnCanvas(ctx, TARGET_ICON, p, '#ff3b3b');
    drawLabelOnCanvas(ctx, 'TARGET', p.x, p.y - 32, '#ff3b3b', 'center');
}

// Function to export data as TXT
function exportDataAsTxt() {
    try {
        const rows = document.querySelectorAll('#input-rows tr');
        const resultCoords = document.getElementById('result-coords').textContent;
        const confidenceLevel = document.getElementById('confidence-value').textContent;

        let txtContent = "SIGINT TRIANGULATION REPORT\n";
        txtContent += "===========================\n\n";
        txtContent += `Date: ${new Date().toLocaleString()}\n\n`;

        txtContent += "INPUT DATA:\n";
        txtContent += "-----------\n";

        rows.forEach((row, index) => {
            const name = rowField(row, 'name').value.trim();
            txtContent += `\n${name || `Signal Source ${index + 1}`}:\n`;
            txtContent += `Location: ${rowField(row, 'position').value}\n`;
            const d = readRow(row);
            txtContent += `Bearing: ${isValidBearing(d.bearing) ? formatBearing(d) : rowField(row, 'bearing').value}\n`;
            txtContent += `Frequency: ${rowField(row, 'freq').value} MHz\n`;
            txtContent += `Signal Strength: ${rowField(row, 'signal').value} dB\n`;
        });

        txtContent += "\nRESULTS:\n";
        txtContent += "--------\n";
        txtContent += `${resultCoords}\n`;
        txtContent += `Confidence Level: ${confidenceLevel}\n`;

        if (pois.length > 0) {
            txtContent += "\nPOINTS OF INTEREST:\n";
            txtContent += "-------------------\n";
            pois.forEach(poi => {
                txtContent += `\n${poi.name}\n`;
                txtContent += `Location: ${formatCoords(poi.position)}\n`;
                if (targetLocation) {
                    txtContent += `Distance to Target: ${formatDistance(calculateDistance(poi.position, targetLocation))}`;
                    txtContent += ` (bearing from target ${calculateBearing(targetLocation, poi.position).toFixed(1)}°)\n`;
                }
            });
        }

        // Create and trigger download
        const blob = new Blob([txtContent], {
            type: 'text/plain'
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `triangulation-report-${new Date().toISOString().slice(0,10)}.txt`;
        link.href = url;
        link.click();

        // Cleanup
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Error exporting data:', error);
        alert('Failed to export data. Please try again.');
    }
}

// Format a distance in km for display
function formatDistance(km) {
    return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(2)} km`;
}

function formatCoords([lat, lng]) {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

// Initial bearing from point1 to point2 in degrees (0-360)
function calculateBearing([lat1, lng1], [lat2, lng2]) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Switch between map tools ('poi', 'measure' or null)
function setMapTool(tool) {
    if (activeTool === 'measure') finishMeasurement();
    activeTool = activeTool === tool ? null : tool;

    document.getElementById('poi-mode').classList.toggle('active', activeTool === 'poi');
    document.getElementById('measure-mode').classList.toggle('active', activeTool === 'measure');
    document.getElementById('map-container').classList.toggle('tool-active', activeTool !== null);

    // Double-click finishes a measurement instead of zooming
    if (activeTool === 'measure') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();

    document.getElementById('map-tool-hint').textContent =
        activeTool === 'poi' ? 'Click the map to place a POI (Esc to stop)' :
        activeTool === 'measure' ? 'Click to add points, double-click or Esc to finish' :
        '';
}

// Add a point of interest
function addPoi(position, name) {
    poiCount++;
    const poi = {
        id: poiCount,
        name: name || `POI ${poiCount}`,
        position
    };

    poi.marker = L.marker(position, {
            icon: L.divIcon({
                className: 'poi-marker',
                html: '<div class="poi-pin"></div>',
                iconSize: [14, 14]
            }),
            exportAs: { kind: 'poi', name: poi.name }
        })
        .addTo(poiLayer)
        .bindTooltip(escapeHtml(poi.name), {
            direction: 'top',
            offset: [0, -8]
        });

    pois.push(poi);
    renderPoiList();
    saveState();
}

function removePoi(id) {
    const poi = pois.find(p => p.id === id);
    if (!poi) return;
    poiLayer.removeLayer(poi.marker);
    pois = pois.filter(p => p.id !== id);
    renderPoiList();
    saveState();
}

// Parse "lat,lng" or "lat lng" into [lat, lng], or null if invalid
function parseCoords(text) {
    const parts = text.trim().split(/[\s,]+/);
    if (parts.length !== 2 || parts.some(p => p === '')) return null;

    const [lat, lng] = parts.map(Number);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

    return [lat, lng];
}

// Add a POI from the name/coordinates form
function addPoiFromForm() {
    const nameInput = document.getElementById('poi-name');
    const coordsInput = document.getElementById('poi-coords');
    const coords = parseCoords(coordsInput.value);

    if (!coords) {
        alert('Invalid coordinates format. Use Lat,Lng format with valid ranges.');
        coordsInput.focus();
        return;
    }

    const [lat, lng] = coords;
    addPoi([lat, lng], nameInput.value.trim());
    nameInput.value = '';
    coordsInput.value = '';
    map.panTo([lat, lng]);
}

// Rebuild the POI table and marker popups (distances depend on the current target)
function renderPoiList() {
    const tbody = document.getElementById('poi-rows');
    tbody.innerHTML = '';
    document.getElementById('poi-table').style.display = pois.length ? '' : 'none';
    document.getElementById('poi-empty').style.display = pois.length ? 'none' : '';

    pois.forEach(poi => {
        let distanceText = 'No target';
        if (targetLocation) {
            const distance = calculateDistance(poi.position, targetLocation);
            const bearing = calculateBearing(targetLocation, poi.position);
            distanceText = `${formatDistance(distance)} @ ${bearing.toFixed(1)}°`;
        }

        poi.marker.bindPopup(`
            <b>${escapeHtml(poi.name)}</b><br>
            ${formatCoords(poi.position)}<br>
            Distance to Target: ${distanceText}
        `);

        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const nameLink = document.createElement('a');
        nameLink.href = '#';
        nameLink.className = 'poi-link';
        nameLink.textContent = poi.name;
        nameLink.addEventListener('click', e => {
            e.preventDefault();
            map.setView(poi.position, Math.max(map.getZoom(), 14));
            poi.marker.openPopup();
        });
        nameCell.appendChild(nameLink);

        // Coordinates are editable in place
        const coordsCell = document.createElement('td');
        const coordsInput = document.createElement('input');
        coordsInput.type = 'text';
        coordsInput.value = formatCoords(poi.position);
        coordsInput.title = 'Edit and press Enter to move this POI';
        coordsInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') coordsInput.blur();
        });
        coordsInput.addEventListener('change', () => {
            const coords = parseCoords(coordsInput.value);
            if (!coords) {
                alert('Invalid coordinates format. Use Lat,Lng format with valid ranges.');
                coordsInput.value = formatCoords(poi.position);
                return;
            }
            poi.position = coords;
            poi.marker.setLatLng(coords);
            renderPoiList();
            saveState();
        });
        coordsCell.appendChild(coordsInput);

        const distanceCell = document.createElement('td');
        distanceCell.className = 'mono';
        distanceCell.textContent = distanceText;

        const actionCell = document.createElement('td');
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'danger';
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', () => removePoi(poi.id));
        actionCell.appendChild(removeButton);

        row.append(nameCell, coordsCell, distanceCell, actionCell);
        tbody.appendChild(row);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Add a vertex to the measurement in progress
function addMeasurePoint(latlng) {
    const point = [latlng.lat, latlng.lng];

    if (!currentMeasure) {
        currentMeasure = {
            points: [],
            layers: [],
            total: 0,
            line: L.polyline([], {
                color: '#fcc419',
                weight: 2,
                opacity: 0.9,
                dashArray: '6 6'
            }).addTo(measureLayer)
        };
        currentMeasure.layers.push(currentMeasure.line);
        measurements.push(currentMeasure.points);
    }

    const points = currentMeasure.points;
    const last = points[points.length - 1];

    // Ignore repeated clicks on the same spot (e.g. the clicks of a double-click)
    if (last && last[0] === point[0] && last[1] === point[1]) return;

    let legText = '';
    if (last) {
        const leg = calculateDistance(last, point);
        currentMeasure.total += leg;
        legText = `Last leg: ${formatDistance(leg)} @ ${calculateBearing(last, point).toFixed(1)}°`;
    }

    points.push(point);
    currentMeasure.line.addLatLng(point);

    const vertex = L.circleMarker(point, {
            radius: 4,
            color: '#fcc419',
            fillColor: '#fcc419',
            fillOpacity: 1,
            weight: 1
        })
        .addTo(measureLayer)
        .bindTooltip(points.length === 1 ? 'Start' : formatDistance(currentMeasure.total), {
            permanent: true,
            direction: 'right',
            className: 'measure-label'
        });
    currentMeasure.layers.push(vertex);
    saveState();

    document.getElementById('map-tool-hint').textContent = points.length === 1 ?
        'Click to add the next point' :
        `Total: ${formatDistance(currentMeasure.total)} | ${legText}`;
}

// Finish the measurement in progress; a single point is not a measurement, so drop it
function finishMeasurement() {
    if (currentMeasure && currentMeasure.points.length < 2) {
        currentMeasure.layers.forEach(layer => measureLayer.removeLayer(layer));
        measurements = measurements.filter(m => m !== currentMeasure.points);
        saveState();
    }
    currentMeasure = null;
}

function clearMeasurements() {
    measureLayer.clearLayers();
    currentMeasure = null;
    measurements = [];
    saveState();
    if (activeTool === 'measure') {
        document.getElementById('map-tool-hint').textContent = 'Click to add points, double-click or Esc to finish';
    }
}

map.on('click', e => {
    if (activeTool === 'poi') {
        const name = prompt('POI name:', `POI ${poiCount + 1}`);
        if (name === null) return;
        addPoi([e.latlng.lat, e.latlng.lng], name.trim());
    } else if (activeTool === 'measure') {
        addMeasurePoint(e.latlng);
    }
});

map.on('dblclick', () => {
    if (activeTool === 'measure') {
        finishMeasurement();
        document.getElementById('map-tool-hint').textContent = 'Measurement finished. Click to start a new one';
    }
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activeTool) setMapTool(null);
});

// Persist everything to localStorage so it survives a page refresh
const STORAGE_KEY = 'sigint-triangulation-state';

function saveState() {
    if (restoring) return;

    const state = {
        rows: Array.from(document.querySelectorAll('#input-rows tr')).map(row => ({
            name: rowField(row, 'name').value,
            position: rowField(row, 'position').value,
            bearing: rowField(row, 'bearing').value,
            freq: rowField(row, 'freq').value,
            signal: rowField(row, 'signal').value
        })),
        triangulated: targetLocation !== null,
        pois: pois.map(poi => ({ name: poi.name, position: poi.position })),
        measurements: measurements.filter(points => points.length >= 2),
        baseLayer: activeBaseLayer,
        view: {
            center: [map.getCenter().lat, map.getCenter().lng],
            zoom: map.getZoom()
        }
    };

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn('Could not save state:', error);
    }
}

// Restore saved state; returns false if there was nothing to restore
function loadState() {
    let state;
    try {
        state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (error) {
        console.warn('Could not load saved state:', error);
        return false;
    }
    if (!state) return false;

    restoring = true;
    try {
        const savedBase = baseLayers[state.baseLayer];
        if (savedBase && state.baseLayer !== activeBaseLayer) {
            map.removeLayer(baseLayers[activeBaseLayer]);
            savedBase.addTo(map);
            activeBaseLayer = state.baseLayer;
        }

        (state.rows && state.rows.length ? state.rows : [{}]).forEach(values => addRow(values));
        (state.pois || []).forEach(poi => addPoi(poi.position, poi.name));

        (state.measurements || []).forEach(points => {
            points.forEach(([lat, lng]) => addMeasurePoint(L.latLng(lat, lng)));
            finishMeasurement();
        });
        document.getElementById('map-tool-hint').textContent = '';

        // Re-run the triangulation from the saved rows
        if (state.triangulated) {
            const rows = document.querySelectorAll('#input-rows tr');
            const data = Array.from(rows).map(readRow);
            if (data.length >= 2 && data.every(d => d.position && isValidBearing(d.bearing))) {
                calculateIntersection(data, { silent: true });
                if (targetLocation) document.getElementById('confidence-level').style.display = 'block';
            }
        }

        if (state.view) map.setView(state.view.center, state.view.zoom);
    } catch (error) {
        console.warn('Saved state was invalid:', error);
    } finally {
        restoring = false;
    }

    renderPoiList();
    saveState();
    return true;
}

// Ask for the map API key once and remember it; an empty entry removes it
function promptApiKey() {
    const entered = prompt('Map API key (leave empty to remove):', key);
    if (entered === null) return;

    key = entered.trim();
    try {
        if (key) localStorage.setItem(API_KEY_STORAGE_KEY, key);
        else localStorage.removeItem(API_KEY_STORAGE_KEY);
    } catch (error) {
        console.warn('Could not save API key:', error);
    }
    darkMap.setUrl(cartoUrl());
}

// Add event listeners
document.getElementById('set-api-key').addEventListener('click', promptApiKey);
document.getElementById('add-row').addEventListener('click', () => addRow());
document.getElementById('input-rows').addEventListener('input', () => {
    drawVectors();
    saveState();
});
map.on('moveend', saveState);
document.getElementById('process-data').addEventListener('click', processData);
document.getElementById('reset-data').addEventListener('click', resetData);
document.getElementById('export-image').addEventListener('click', exportMapImage);
document.getElementById('export-txt').addEventListener('click', exportDataAsTxt);
document.getElementById('poi-mode').addEventListener('click', () => setMapTool('poi'));
document.getElementById('measure-mode').addEventListener('click', () => setMapTool('measure'));
document.getElementById('clear-measure').addEventListener('click', clearMeasurements);
document.getElementById('add-poi').addEventListener('click', addPoiFromForm);
['poi-name', 'poi-coords'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') addPoiFromForm();
    });
});

// Restore the previous session, or start with one empty row
if (!loadState()) {
    addRow();
    renderPoiList();
}