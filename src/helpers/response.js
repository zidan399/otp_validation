exports.sendError = (res, status, message) => {
  return res.status(status).json({
    success: false,
    error: { code: status, message },
  });
};
