# Runs the local terminal proxy. Build from a folder that also holds your own
# portfolio.py, terminal_chat.py and terminal/ (index.html, app.js, settings.js, style.css).
FROM python:3.12-slim
WORKDIR /app
COPY terminal_server.py portfolio.py terminal_chat.py ./
COPY terminal/ ./terminal/
ENV TERMINAL_HOST=0.0.0.0 TERMINAL_PORT=8765 PYTHONUNBUFFERED=1
EXPOSE 8765
USER nobody
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:8765/api/health', headers={'Host':'127.0.0.1:8765'}), timeout=3)"
CMD ["python", "terminal_server.py"]
