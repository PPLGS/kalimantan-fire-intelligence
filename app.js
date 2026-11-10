
// ==========================================
// KALIMANTAN FIRE INTELLIGENCE
// WEBGIS + GEOTIFF + JUPYTER NOTEBOOK
// ==========================================

// ==========================================
// 1. INISIALISASI PETA
// ==========================================

const map = L.map('map').setView([-1.5, 114], 5);

L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  }
).addTo(map);

const layers = new Map();
let seq = 0;
let charts = {};

const fmt = n => Number(n || 0).toLocaleString('id-ID');

// ==========================================
// 2. FUNGSI DASAR
// ==========================================

function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function msg(s) {
  document.getElementById('message').textContent = s;
}

function keyOf(obj, candidates) {
  return Object.keys(obj || {}).find(k =>
    candidates.includes(k.toLowerCase().trim())
  );
}

function popup(feature, layer) {
  const properties = feature.properties || {};

  const html = Object.entries(properties)
    .slice(0, 30)
    .map(([k, v]) =>
      `<div><b>${safe(k)}:</b> ${safe(v)}</div>`
    ).join('');

  layer.bindPopup(
    `<div style="max-height:220px;overflow:auto">
      <b>Informasi fitur</b>${html}
    </div>`
  );
}

// ==========================================
// 3. MENAMBAHKAN DATA GEOJSON
// ==========================================

function addGeo(data, name, type = 'GeoJSON') {
  if (!data || !data.type) {
    throw Error('Format GeoJSON tidak valid.');
  }

  const layer = L.geoJSON(data, {
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, {
        radius: 5,
        color: '#e8fff7',
        weight: 1,
        fillColor: '#ff715f',
        fillOpacity: 0.95
      }),

    style: () => ({
      color: '#ffad5c',
      weight: 1.5,
      fillColor: '#e86d54',
      fillOpacity: 0.3
    }),

    onEachFeature: popup
  }).addTo(map);

  const count = data.type === 'FeatureCollection'
    ? (data.features || []).length
    : 1;

  const id = ++seq;

  layers.set(id, {
    id,
    name,
    type,
    count,
    layer,
    data,
    visible: true
  });

  update();

  if (layer.getBounds().isValid()) {
    map.fitBounds(layer.getBounds().pad(0.1));
  }
}

// ==========================================
// 4. MEMBACA DAN MENAMPILKAN GEOTIFF
// ==========================================

function rasterColor(georaster) {
  const min = Number(georaster.mins?.[0] ?? 0);
  const max = Number(georaster.maxs?.[0] ?? 255);

  const noData = georaster.noDataValue;

  return function (values) {
    if (!values || !values.length) return null;

    // Raster RGB / multiband
    if (values.length >= 3) {
      const r = Number(values[0]);
      const g = Number(values[1]);
      const b = Number(values[2]);

      if (![r, g, b].every(Number.isFinite)) return null;

      if (
        noData !== null &&
        noData !== undefined &&
        values.every(v => v === noData)
      ) return null;

      return `rgb(
        ${Math.max(0, Math.min(255, r))}
        ${Math.max(0, Math.min(255, g))}
        ${Math.max(0, Math.min(255, b))}
      )`;
    }

    // Raster single band
    const value = Number(values[0]);

    if (!Number.isFinite(value)) return null;

    if (
      noData !== null &&
      noData !== undefined &&
      value === noData
    ) return null;

    const range = max - min;

    const normalized = range === 0
      ? 0.5
      : Math.max(0, Math.min(1, (value - min) / range));

    // Gradasi warna untuk raster single band
    const r = Math.round(35 + normalized * 220);
    const g = Math.round(70 + normalized * 100);
    const b = Math.round(180 - normalized * 155);

    return `rgb(${r},${g},${b})`;
  };
}

async function addGeoTIFF(file) {
  if (
    typeof parseGeoraster !== 'function' ||
    typeof GeoRasterLayer !== 'function'
  ) {
    throw Error(
      'Library GeoTIFF belum tersedia. Periksa library pada indeks.html.'
    );
  }

  msg('Membaca raster GeoTIFF...');

  const arrayBuffer = await file.arrayBuffer();

  const georaster = await parseGeoraster(arrayBuffer);

  if (!georaster) {
    throw Error('File GeoTIFF tidak dapat dibaca.');
  }

  const rasterLayer = new GeoRasterLayer({
    georaster: georaster,
    opacity: 0.75,
    resolution: 128,
    pixelValuesToColorFn: rasterColor(georaster)
  });

  rasterLayer.addTo(map);

  const bounds = rasterLayer.getBounds();

  if (!bounds || !bounds.isValid()) {
    map.removeLayer(rasterLayer);
    throw Error(
      'Koordinat raster tidak valid atau tidak didukung.'
    );
  }

  const id = ++seq;

  const width = georaster.width;
  const height = georaster.height;

  layers.set(id, {
    id,
    name: file.name,
    type: 'GeoTIFF',
    count: 1,
    layer: rasterLayer,
    data: null,
    visible: true,
    rasterInfo: {
      width,
      height,
      bands: georaster.numberOfRasters,
      projection: georaster.projection
    }
  });

  update();

  map.fitBounds(bounds.pad(0.1));

  msg(
    `Berhasil memuat GeoTIFF: ${file.name} ` +
    `(${width} × ${height} piksel).`
  );
}

// ==========================================
// 5. UPDATE DAFTAR LAYER DAN STATISTIK
// ==========================================

function update() {
  const rows = document.getElementById('dataRows');
  const list = document.getElementById('layers');

  rows.innerHTML = '';
  list.innerHTML = '';

  if (!layers.size) {
    rows.innerHTML =
      '<tr><td colspan="3" class="empty">Belum ada data.</td></tr>';

    list.innerHTML =
      '<div class="empty">Belum ada data dimuat.</div>';
  }

  let points = 0;
  let provinces = new Set();
  let hectares = 0;
  let hasArea = false;
  let years = {};
  const types = {};

  for (const record of layers.values()) {
    types[record.type] =
      (types[record.type] || 0) + record.count;

    // Data raster tidak mempunyai daftar fitur vektor.
    (record.data?.features || []).forEach(feature => {
      if (feature.geometry?.type === 'Point') {
        points++;
      }

      const properties = feature.properties || {};

      const provinceKey = keyOf(properties, [
        'provinsi',
        'province',
        'nama_provinsi'
      ]);

      if (provinceKey && properties[provinceKey]) {
        provinces.add(String(properties[provinceKey]));
      }

      const areaKey = keyOf(properties, [
        'area_ha',
        'luas_ha',
        'luas_hektar'
      ]);

      if (
        areaKey &&
        Number.isFinite(+properties[areaKey])
      ) {
        hectares += +properties[areaKey];
        hasArea = true;
      }

      const yearKey = keyOf(properties, [
        'tahun',
        'year',
        'acq_year'
      ]);

      if (yearKey && properties[yearKey]) {
        years[properties[yearKey]] =
          (years[properties[yearKey]] || 0) + 1;
      }
    });

    const featureInfo = record.type === 'GeoTIFF'
      ? 'Raster'
      : fmt(record.count);

    rows.innerHTML += `
      <tr>
        <td>${safe(record.name)}</td>
        <td>${safe(record.type)}</td>
        <td>${featureInfo}</td>
      </tr>
    `;

    const element = document.createElement('div');
    element.className = 'layer';

    const extraInfo = record.rasterInfo
      ? `${record.rasterInfo.width} × ${record.rasterInfo.height} px · ${record.rasterInfo.bands} band`
      : `${fmt(record.count)} fitur`;

    element.innerHTML = `
      <span>
        ${safe(record.name)}<br>
        <small>
          ${safe(record.type)} · ${extraInfo}
        </small>
      </span>

      <span style="display:flex;align-items:center;gap:8px">
        <input
          type="checkbox"
          ${record.visible ? 'checked' : ''}
          aria-label="Tampilkan layer"
        >
        <button type="button">Hapus</button>
      </span>
    `;

    // Aktif/nonaktif layer
    element.querySelector('input').onchange = event => {
      record.visible = event.target.checked;

      if (record.visible) {
        record.layer.addTo(map);
      } else {
        map.removeLayer(record.layer);
      }
    };

    // Penghapusan layer
    element.querySelector('button').onclick = () => {
      map.removeLayer(record.layer);
      layers.delete(record.id);
      update();
    };

    list.appendChild(element);
  }

  document.getElementById('hotspotCount').textContent =
    fmt(points);

  document.getElementById('burnedArea').textContent =
    hasArea ? fmt(hectares) + ' ha' : '—';

  document.getElementById('layerCount').textContent =
    layers.size;

  document.getElementById('provinceCount').textContent =
    provinces.size;

  drawCharts(types, years);
}

// ==========================================
// 6. GRAFIK
// ==========================================

function drawCharts(types, years) {
  Object.values(charts).forEach(chart => chart.destroy());

  const common = {
    plugins: {
      legend: {
        labels: {
          color: '#a9c0c5',
          font: { size: 9 },
          boxWidth: 8
        }
      }
    },
    maintainAspectRatio: false
  };

  const typeLabels = Object.keys(types).length
    ? Object.keys(types)
    : ['Belum ada data'];

  const typeValues = Object.keys(types).length
    ? Object.values(types)
    : [1];

  charts.types = new Chart(
    document.getElementById('typeChart'),
    {
      type: 'doughnut',
      data: {
        labels: typeLabels,
        datasets: [{
          data: typeValues,
          backgroundColor: [
            '#58e0b1',
            '#ffb45e',
            '#ff6c62',
            '#62b9e9',
            '#9c83db'
          ],
          borderWidth: 0
        }]
      },
      options: {
        ...common,
        cutout: '70%'
      }
    }
  );

  const sortedYears = Object.keys(years).sort();

  charts.years = new Chart(
    document.getElementById('yearChart'),
    {
      type: 'bar',
      data: {
        labels: sortedYears,
        datasets: [{
          data: sortedYears.map(year => years[year]),
          backgroundColor: '#58e0b1',
          borderRadius: 4
        }]
      },
      options: {
        ...common,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            ticks: {
              color: '#91aab1',
              font: { size: 9 }
            },
            grid: { display: false }
          },
          y: {
            ticks: {
              color: '#91aab1',
              font: { size: 9 }
            },
            grid: { color: '#1d3945' }
          }
        }
      }
    }
  );
}

// ==========================================
// 7. PRATINJAU JUPYTER NOTEBOOK
// ==========================================

function renderNotebook(notebook, fileName) {
  const panel = document.getElementById('notebookPanel');
  const content = document.getElementById('notebookContent');

  const cells = Array.isArray(notebook.cells)
    ? notebook.cells
    : [];

  const codeCount =
    cells.filter(cell => cell.cell_type === 'code').length;

  const markdownCount =
    cells.filter(cell => cell.cell_type === 'markdown').length;

  document.getElementById('notebookInfo').textContent =
    `${fileName} · ${cells.length} sel · ${codeCount} kode · ${markdownCount} markdown · kernel ${
      notebook.metadata?.kernelspec?.display_name ||
      notebook.metadata?.kernelspec?.name ||
      'tidak diketahui'
    }`;

  content.innerHTML = '';

  if (!cells.length) {
    content.textContent =
      'Notebook tidak memiliki sel yang dapat ditampilkan.';

    panel.style.display = 'block';
    return;
  }

  cells.forEach((cell, index) => {
    const wrapper = document.createElement('section');

    wrapper.style.cssText =
      'border:1px solid #1d3945;border-radius:8px;background:#0a1720;padding:12px;overflow:auto';

    const heading = document.createElement('div');

    heading.style.cssText =
      'font:9px "DM Mono";color:#58e0b1;margin-bottom:8px;text-transform:uppercase';

    heading.textContent =
      `SEL ${index + 1} · ${(cell.cell_type || 'unknown').toUpperCase()}`;

    wrapper.appendChild(heading);

    const source = Array.isArray(cell.source)
      ? cell.source.join('')
      : String(cell.source || '');

    const pre = document.createElement(
      cell.cell_type === 'markdown' ? 'div' : 'pre'
    );

    pre.style.cssText =
      cell.cell_type === 'markdown'
        ? 'white-space:pre-wrap;color:#d7e8e9;font-size:11px;line-height:1.65;margin:0'
        : 'white-space:pre-wrap;overflow-wrap:anywhere;background:#10232d;color:#d7e8e9;padding:10px;border-radius:6px;font:10px/1.6 "DM Mono",monospace;margin:0';

    pre.textContent = source;
    wrapper.appendChild(pre);

    if (
      cell.cell_type === 'code' &&
      Array.isArray(cell.outputs)
    ) {
      cell.outputs.forEach(output => {
        const data = output.data || {};

        const textOutput = data['text/plain'] || output.text || '';

        if (textOutput) {
          const outputElement = document.createElement('pre');

          outputElement.style.cssText =
            'white-space:pre-wrap;overflow-wrap:anywhere;background:#071018;border-left:2px solid #58e0b1;color:#a9c6c9;padding:9px;margin:8px 0 0;font:10px/1.5 "DM Mono",monospace';

          outputElement.textContent = Array.isArray(textOutput)
            ? textOutput.join('')
            : String(textOutput);

          wrapper.appendChild(outputElement);
        }

        if (data['image/png']) {
          const image = document.createElement('img');

          image.alt = 'Output gambar dari notebook';
          image.loading = 'lazy';

          image.style.cssText =
            'display:block;max-width:100%;height:auto;margin-top:8px;border-radius:5px';

          image.src =
            'data:image/png;base64,' +
            (
              Array.isArray(data['image/png'])
                ? data['image/png'].join('')
                : data['image/png']
            );

          wrapper.appendChild(image);
        }
      });
    }

    content.appendChild(wrapper);
  });

  panel.style.display = 'block';

  panel.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
}

// ==========================================
// 8. UPLOAD SEMUA FORMAT DATA
// ==========================================

document.getElementById('loadBtn').onclick = async () => {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];

  if (!file) {
    msg('Pilih file terlebih dahulu.');
    return;
  }

  try {
    msg('Memproses ' + file.name + ' ...');

    const extension = file.name
      .split('.')
      .pop()
      .toLowerCase();

    // JUPYTER NOTEBOOK
    if (extension === 'ipynb') {
      const notebook = JSON.parse(await file.text());

      if (!Array.isArray(notebook.cells)) {
        throw Error(
          'Struktur file IPYNB tidak valid atau tidak memiliki array cells.'
        );
      }

      renderNotebook(notebook, file.name);

      msg(
        'Berhasil membuka pratinjau notebook ' +
        file.name +
        '. Kode Python tidak dieksekusi di browser.'
      );
    }

    // GEOTIFF
    else if (
      extension === 'tif' ||
      extension === 'tiff'
    ) {
      await addGeoTIFF(file);
    }

    // GEOJSON
    else if (
      extension === 'geojson' ||
      extension === 'json'
    ) {
      addGeo(
        JSON.parse(await file.text()),
        file.name,
        'GeoJSON'
      );
    }

    // SHAPEFILE ZIP
    else if (extension === 'zip') {
      const result = await shp(await file.arrayBuffer());

      if (result.type === 'FeatureCollection') {
        addGeo(result, file.name, 'Shapefile');
      } else {
        Object.entries(result).forEach(([name, data]) => {
          addGeo(
            data,
            file.name + ' · ' + name,
            'Shapefile'
          );
        });
      }
    }

    // CSV
    else if (extension === 'csv') {
      const parsed = await new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: result => resolve(result.data),
          error: reject
        });
      });

      if (!parsed.length) {
        throw Error('CSV kosong');
      }

      const latitude = keyOf(parsed[0], [
        'latitude',
        'lat',
        'y'
      ]);

      const longitude = keyOf(parsed[0], [
        'longitude',
        'lon',
        'long',
        'lng',
        'x'
      ]);

      if (!latitude || !longitude) {
        throw Error(
          'Kolom koordinat perlu bernama latitude/longitude atau lat/lon.'
        );
      }

      const features = parsed
        .map(row => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [
              +row[longitude],
              +row[latitude]
            ]
          },
          properties: row
        }))
        .filter(feature =>
          Number.isFinite(feature.geometry.coordinates[0]) &&
          Number.isFinite(feature.geometry.coordinates[1])
        );

      addGeo(
        {
          type: 'FeatureCollection',
          features
        },
        file.name,
        'CSV'
      );
    }

    else {
      throw Error(
        'Format ini belum didukung langsung pada prototipe ini.'
      );
    }

    if (extension !== 'ipynb' &&
        extension !== 'tif' &&
        extension !== 'tiff') {
      msg('Berhasil memuat ' + file.name + '.');
    }

  } catch (error) {
    console.error(error);
    msg('Gagal: ' + error.message);
  }
};

// ==========================================
// 9. ZOOM DAN RESET PETA
// ==========================================

document.getElementById('fitBtn').onclick = () => {
  let bounds = L.latLngBounds([]);

  layers.forEach(record => {
    if (
      record.visible &&
      record.layer.getBounds?.().isValid()
    ) {
      bounds.extend(record.layer.getBounds());
    }
  });

  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.1));
  } else {
    map.setView([-1.5, 114], 5);
  }
};

document.getElementById('resetBtn').onclick = () => {
  map.setView([-1.5, 114], 5);
};

// ==========================================
// 10. EKSPOR CSV
// ==========================================

document.getElementById('exportBtn').onclick = () => {
  const csv =
    'Nama layer,Jenis,Jumlah fitur\n' +
    [...layers.values()]
      .map(record =>
        [
          record.name,
          record.type,
          record.count
        ]
          .map(value =>
            '"' + String(value).replace(/"/g, '""') + '"'
          )
          .join(',')
      )
      .join('\n');

  const link = document.createElement('a');

  link.href = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv' })
  );

  link.download = 'ringkasan-karhutla.csv';
  link.click();

  URL.revokeObjectURL(link.href);
};

// ==========================================
// 11. TANGGAL
// ==========================================

document.getElementById('dateNow').textContent =
  new Date().toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });

// ==========================================
// 12. HAPUS NOTEBOOK
// ==========================================

const deleteNotebookButton =
  document.getElementById('deleteNotebookBtn');

if (deleteNotebookButton) {
  deleteNotebookButton.addEventListener('click', () => {
    const panel = document.getElementById('notebookPanel');
    const content = document.getElementById('notebookContent');
    const info = document.getElementById('notebookInfo');
    const fileInput = document.getElementById('fileInput');

    if (!panel || panel.style.display === 'none') return;

    if (!confirm(
      'Apakah Anda yakin ingin menghapus pratinjau Jupyter Notebook ini?'
    )) return;

    content.replaceChildren();

    info.textContent = 'Belum ada notebook yang dimuat.';

    panel.style.display = 'none';

    if (
      fileInput.files.length &&
      fileInput.files[0].name.toLowerCase().endsWith('.ipynb')
    ) {
      fileInput.value = '';
    }

    msg('Pratinjau notebook berhasil dihapus.');
  });
}

// ==========================================
// 13. UPDATE AWAL
// ==========================================

update();

// ==========================================
// 14. ANIMASI VISUAL GLOBE 3D
// ==========================================

(function init3D() {
  const host = document.getElementById('scene');

  if (!window.THREE) {
    host.innerHTML +=
      '<p style="padding:25px;color:#9ab">3D visual membutuhkan koneksi internet.</p>';
    return;
  }

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    42,
    host.clientWidth / host.clientHeight,
    0.1,
    100
  );

  camera.position.set(0, 0, 6.3);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });

  renderer.setPixelRatio(
    Math.min(devicePixelRatio, 2)
  );

  renderer.setSize(
    host.clientWidth,
    host.clientHeight
  );

  host.prepend(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1.65, 64, 64),
    new THREE.MeshPhongMaterial({
      color: 0x174b50,
      emissive: 0x071c25,
      shininess: 24,
      transparent: true,
      opacity: 0.94
    })
  );

  group.add(earth);

  const wire = new THREE.Mesh(
    new THREE.SphereGeometry(1.68, 32, 24),
    new THREE.MeshBasicMaterial({
      color: 0x4eddb0,
      wireframe: true,
      transparent: true,
      opacity: 0.12
    })
  );

  group.add(wire);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1.78, 48, 48),
    new THREE.MeshBasicMaterial({
      color: 0x42d9ac,
      transparent: true,
      opacity: 0.055,
      side: THREE.BackSide
    })
  );

  group.add(atmosphere);

  const points = [];

  for (let i = 0; i < 90; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.25 + Math.random() * 0.95;

    const x = Math.cos(angle) * radius * 0.65 - 0.15;
    const y = Math.sin(angle) * radius * 0.95 + 0.08;

    points.push(x, y, 1.665);
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3)
  );

  const dots = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffa65a,
      size: 0.035,
      transparent: true,
      opacity: 0.85
    })
  );

  group.add(dots);

  const orbit = new THREE.Mesh(
    new THREE.TorusGeometry(2.12, 0.006, 8, 150),
    new THREE.MeshBasicMaterial({
      color: 0x4ad7ad,
      transparent: true,
      opacity: 0.45
    })
  );

  orbit.rotation.x = 1.1;
  orbit.rotation.y = 0.3;

  group.add(orbit);

  const light = new THREE.PointLight(
    0x8ffff0,
    3,
    12
  );

  light.position.set(3, 3, 4);

  scene.add(light);
  scene.add(new THREE.AmbientLight(0x9bcac8, 1.4));

  const starGeometry = new THREE.BufferGeometry();
  const starPositions = [];

  for (let i = 0; i < 500; i++) {
    starPositions.push(
      (Math.random() - 0.5) * 13,
      (Math.random() - 0.5) * 7,
      (Math.random() - 0.5) * 5 - 2
    );
  }

  starGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(starPositions, 3)
  );

  scene.add(
    new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0x78a6a9,
        size: 0.009,
        transparent: true,
        opacity: 0.5
      })
    )
  );

  let tick = 0;

  function animate() {
    requestAnimationFrame(animate);

    tick += 0.004;

    group.rotation.y =
      Math.sin(tick * 0.55) * 0.23 + tick * 0.08;

    group.rotation.x =
      Math.sin(tick * 0.4) * 0.06;

    wire.rotation.y = -tick * 0.12;
    orbit.rotation.z = tick * 0.16;

    dots.material.opacity =
      0.55 + 0.3 * Math.sin(tick * 3);

    renderer.render(scene, camera);
  }

  animate();

  new ResizeObserver(() => {
    const width = host.clientWidth;
    const height = host.clientHeight;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setSize(width, height);
  }).observe(host);
})();
