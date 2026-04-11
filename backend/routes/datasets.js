const express = require("express")
const router = express.Router()
const fs = require('node:fs')
const db = require("../database/db")
const db_lib = require("../database/db-lib")
const crypto = require('crypto')
const path = require('node:path')
const cors = require('cors')
const multer = require('multer')
const RESOLUTIONS = [
  0.01,  // 10 ms
  0.05,  // 50 ms
  0.2,   // 200 ms
  0.5,   // 500 ms
  1,     // 1 s
  5,     // 5 s
  10     // 10 s
]
const RESOLUTION_LABELS = ['10 ms', '50 ms', '200 ms', '500 ms', '1 s', '5 s', '10 s']

// Import and initialize storage system
const storage_lib  = require('../storage')
const storage = storage_lib.getStorage()

// Define Microservices URL
const MICROSERVICES_URL = process.env.MICROSERVICES_URL

// Enable CORS for this router
router.use(cors())

const localTempDir = path.join(__dirname, '..', 'tmp', 'uploads')
if (!fs.existsSync(localTempDir)) {
    fs.mkdirSync(localTempDir, { recursive: true })
}

const tempStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, localTempDir)
    },
    filename: function (req, file, cb) {
        const tempId = crypto.randomUUID()
        req.tempId = tempId
        const ext = path.extname(file.originalname)
        cb(null, `${tempId}${ext}`)
    }
})

const upload = multer({ storage: tempStorage })

router.get("/", (req, res) => {
    const stmt = db.prepare("SELECT * FROM Dataset")
    const datasets = stmt.all()
    res.json(datasets)
})

router.get("/:id", (req, res) => {
	const dataset = db_lib.getDatasetByID(req.params.id)
	res.json(dataset)
})

// Returns all files associated with a dataset
router.get("/files/:id", async (req, res) => {
	const datasetID = req.params.id
	const files = await storage.datasetFiles(datasetID)
	return res.json(files)
})

router.get('/download/:id', async (req, res) => {
	const datasetID = req.params.id;
	const key = `${datasetID}.json`

	if (!db_lib.getDatasetByID(datasetID)) {
		const err = `error: dataset with id ${datasetID} does not exist.`
		return res.status(404).json({ error: err })
	}
	try {
		if (!await storage.exists(key)) {
			const err = `error: datafile with key: ${key} does not exist, yet it has a corresponding dataset`
			console.error(err)
			return res.status(404).json({ error: err })
		}

		const metadata = await storage.stat(key)

		res.setHeader('Content-Type', 'application/json')
		res.setHeader('Content-Disposition', `attachment; filename="${datasetID}.json"`)
		res.setHeader('Content-Length', metadata.size)

		const stream = await storage.getReadStream(key)
		stream.pipe(res)

		stream.on('error', (err) => {
			console.error('Stream error:', err);
			if(!res.headersSent) {
				return res.status(500).json({ error: "Error streaming file" });
			}
		})

	} catch (err) {
		console.error("Download error:", err);
		res.status(500).json({ error: "Error downloading file" });
	}
})

router.get('/download/csv/:id', async (req, res) => {
	const datasetID = req.params.id;
	const json_key = `${datasetID}.json`
	const csv_key = `${datasetID}.csv`

	const dataset_meta = db_lib.getDatasetByID(datasetID)
	if (!dataset_meta) {
		return res.status(404).json({ error: "Dataset not found" });
	}

	let needsConversion = false;

	if (!await storage.exists(csv_key)) {
		needsConversion = true;
	} else {
		const csvStats = await storage.stat(csv_key);
		const csvModTime = csvStats.lastModified;
		const datasetUpdatedAt = new Date(dataset_meta.updated_at);

		if (csvModTime < datasetUpdatedAt) {
			needsConversion = true;
		}
	}

	if (needsConversion) {
		try {
			const response = await fetch(`${MICROSERVICES_URL}/convert/json/csv`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					input_path: json_key,
					output_path: csv_key
				})
			});

			if (!response.ok) {
				return res.status(500).json({ error: "Failed to convert JSON to CSV" });
			}
		} catch (err) {
			console.error("Microservices error:", err);
			return res.status(500).json({ error: "Microservices unavailable" });
		}
	}

	try {
		const metadata = await storage.stat(csv_key);

		res.setHeader('Content-Type', 'text/csv');
		res.setHeader('Content-Disposition', `attachment; filename="${datasetID}.csv"`);
		res.setHeader('Content-Length', metadata.size);

		const stream = await storage.getReadStream(csv_key)
		stream.pipe(res)

		stream.on('error', (err) => {
			console.error('Stream error:', err);
			if(!res.headersSent) {
				return res.status(500).json({ error: "Error streaming file" });
			}
		})
	} catch (err) {
		console.error("Download error:", err);
		res.status(500).json({ error: "Error downloading file" });
	}
})

// Returns dataset data filtered by resolution (in seconds), caches result to storage
router.get('/data/:id', async (req, res) => {
	const datasetID = req.params.id;
	const resolution = parseFloat(req.query.resolution) || 1;

	if (!RESOLUTIONS.includes(resolution)) {
		return res.status(400).json({ error: `Invalid resolution. Must be one of: ${RESOLUTIONS.join(', ')}` });
	}

	if (!db_lib.getDatasetByID(datasetID)) {
		return res.status(404).json({ error: `Dataset with id ${datasetID} does not exist.` });
	}

	const sourceKey = `${datasetID}.json`;
	const label = RESOLUTION_LABELS[RESOLUTIONS.indexOf(resolution)];
	const cachedKey = `${datasetID}-${label}.json`;

	try {
		if (!await storage.exists(sourceKey)) {
			return res.status(404).json({ error: `Data file not found for dataset ${datasetID}` });
		}

		if (await storage.exists(cachedKey)) {
			const cached = await storage.read(cachedKey);
			return res.json(JSON.parse(cached.toString()));
		}

		const raw = await storage.read(sourceKey);
		const dataJSON = JSON.parse(raw.toString());

		const baseTime = dataJSON[0]?.sec ?? 0;
		const seen = new Set();
		const filtered = dataJSON.filter((elem) => {
			const bucket = Math.floor((elem.sec - baseTime) / resolution);
			if (seen.has(bucket)) return false;
			seen.add(bucket);
			return true;
		});

		await storage.write(cachedKey, JSON.stringify(filtered));

		res.json(filtered);
	} catch (err) {
		console.error("Error fetching dataset data:", err);
		res.status(500).json({ error: err.message });
	}
});

// Receives a dataset file and uploads it to a temporary folder for further processing, returns a temporary ID
router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' })
    }

    const tempId = req.tempId
    const storageKey = `tmp/${tempId}`
    const localPath = req.file.path

    try {
        const data = await fs.promises.readFile(localPath)
        await storage.write(storageKey, data)
        await fs.promises.unlink(localPath)

        res.status(201).json({ tempId })
    } catch (err) {
        console.error(`Error storing temp upload: ${err}`)
        res.status(500).json({ error: err.message })
    }
})

// Returns validation information on the temporary dataset
router.post('/validate/:tempID', async (req, res) => {
	return res.status(200).json({ valid: true })
})

// Confirms the upload: moves the temp file to permanent storage and creates the DB record
router.post('/upload/confirm', async (req, res) => {
	const { tempId, title, description, date, location_id, vehicle_id, competition } = req.body

	if (!tempId || !title || !date) {
		return res.status(400).json({ error: "Missing required fields (tempId, title, date)" })
	}

	const tempKey = `tmp/${tempId}`

	try {
		if (!await storage.exists(tempKey)) {
			return res.status(404).json({ error: "Temp upload not found. It may have expired. Please re-upload the dataset." })
		}

		const id = crypto.randomUUID()
		const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

		let formattedDate
		if (date.includes('T')) {
			formattedDate = date.replace('T', ' ') + ':00'
		} else if (date.includes(':')) {
			formattedDate = date
		} else {
			formattedDate = `${date} 00:00:00`
		}

		const permanentKey = `${id}.json`
		const data = await storage.read(tempKey)
		await storage.write(permanentKey, data)
		await storage.delete(tempKey)

		const stmt = db.prepare(`
			INSERT INTO Dataset (id, title, description, date, uploaded_at, updated_at,
			                     location_id, vehicle_id, competition)
			VALUES (@id, @title, @description, @date, @uploaded_at,
			        @updated_at, @location_id, @vehicle_id, @competition)`)
		stmt.run({
			id,
			title,
			description: description || null,
			date: formattedDate,
			uploaded_at: now,
			updated_at: now,
			location_id: location_id || null,
			vehicle_id: vehicle_id || null,
			competition: competition ? 1 : 0,
		})

		res.status(201).json({ id })
	} catch (err) {
		console.error(`Error confirming upload: ${err}`)
		res.status(500).json({ error: err.message })
	}
})

router.delete('/delete/:id', async (req, res) => {
	const datasetID = req.params.id
	const files = await storage.datasetFiles(datasetID)

	try {
		if (!db_lib.getDatasetByID(datasetID)) {
			return res.status(404).json({ error: `dataset with ${datasetID} does not exist.` })
		}
		db_lib.deleteDatasetByID(datasetID)
		for (const key of files) {
			await storage.delete(key)
		}
	} catch (err) {
		console.error(`Error deleting dataset ${datasetID}: ${err}`)
		return res.status(500).json({ error: err.message })
	}
	return res.status(200).json({ message: `Dataset ${datasetID} deleted` })
})

module.exports = router;