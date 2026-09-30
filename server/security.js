function rejectRawWrite(req, res) {
    return res.status(405).json({
        error: 'Raw YAML writes are disabled; use the structured configuration endpoints',
        code: 'raw_writes_disabled'
    });
}

module.exports = { rejectRawWrite };
