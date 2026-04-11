import { useState, useEffect, useCallback } from 'react'
import { api } from '../api/backend'
import { useParams } from 'react-router'
import Plot from 'react-plotly.js'

const RESOLUTIONS = [0.01, 0.05, 0.2, 0.5, 1, 5, 10]
const RESOLUTION_LABELS = ['10 ms', '50 ms', '200 ms', '500 ms', '1 s', '5 s', '10 s']

function DatasetGraph() {
    const { id } = useParams();
    const [data, setData] = useState(null)
    const [loaded, setLoaded] = useState(false)
    const [initialTime, setInitialTime] = useState(0)
    const [resolutionIndex, setResolutionIndex] = useState(4) // default: 1s
    const [fetching, setFetching] = useState(false)

    const fetchData = useCallback((resIdx) => {
        const resolution = RESOLUTIONS[resIdx]
        setFetching(true)
        setLoaded(false)

        api.getDatasetData(id, resolution)
            .then((res) => res.json())
            .then((dataJSON) => {
                setData(dataJSON)
                setInitialTime(dataJSON[0].sec)
                setLoaded(true)
            })
            .catch((err) => console.error('Failed to fetch data:', err))
            .finally(() => setFetching(false))
    }, [id])

    useEffect(() => {
        fetchData(resolutionIndex)
    }, [])

    const handleSliderChange = (e) => {
        const idx = parseInt(e.target.value)
        setResolutionIndex(idx)
        fetchData(idx)
    }

    return (
        <div style={{ padding: '1rem' }}>
            <div style={{ marginBottom: '1rem' }}>
                <label style={{ fontWeight: 'bold' }}>
                    Resolution: {RESOLUTION_LABELS[resolutionIndex]}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem' }}>10 ms</span>
                    <input
                        type="range"
                        min={0}
                        max={RESOLUTIONS.length - 1}
                        step={1}
                        value={resolutionIndex}
                        onChange={handleSliderChange}
                        disabled={fetching}
                        style={{ width: '300px' }}
                    />
                    <span style={{ fontSize: '0.8rem' }}>10 s</span>
                </div>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '300px',
                    marginLeft: '34px',
                    marginTop: '4px'
                }}>
                    {RESOLUTION_LABELS.map((label) => (
                        <span key={label} style={{ fontSize: '0.7rem', color: '#666' }}>{label}</span>
                    ))}
                </div>
            </div>

            {fetching && <p>Loading data...</p>}

            {loaded && !fetching && (
                <Plot
                    data={[
                        {
                            x: data.map((elem) => elem.sec - initialTime),
                            y: data.map((elem) => elem.RearBrakePressure),
                            type: 'scatter',
                            mode: 'lines',
                            marker: { color: 'red' },
                            name: 'Rear Brake Pressure',
                        },
                    ]}
                    layout={{ width: 1200, height: 800, title: { text: 'A Fancy Plot' } }}
                />
            )}
        </div>
    )
}

export default DatasetGraph