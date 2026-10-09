ARG PYTHON_VERSION="3.13-slim"
ARG USERNAME=colossyan

FROM python:$PYTHON_VERSION

WORKDIR /code

ENV PIP_NO_CACHE_DIR=off \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

ENV UID=1000 \
    GID=1000

ARG USERNAME

RUN groupadd --gid $GID $USERNAME \
    && useradd --uid $UID --gid $GID -m $USERNAME \
    && chown -R $UID:$GID /code

COPY requirements.txt .
RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    rm requirements.txt

COPY /config ./config
COPY /scripts ./scripts
COPY main.py .

USER $USERNAME
CMD ["python3", "main.py"]
