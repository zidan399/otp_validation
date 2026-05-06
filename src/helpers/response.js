exports.sendError = (res, status, message, incremented = true) => {
  return res.status(status).json({
    success: false,
    error: { code: status, message },
    incremented
  });
};
