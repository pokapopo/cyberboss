function apiKeyAuth(config) {
  const apiKey = config.apiKey || "";

  return (req, res, next) => {
    if (!apiKey) {
      return next();
    }

    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== apiKey) {
      return res
        .status(401)
        .json({
          error: {
            message: "Invalid API key. Use 'Authorization: Bearer <key>' header.",
            type: "authentication_error",
          },
        });
    }
    next();
  };
}

module.exports = { apiKeyAuth };
