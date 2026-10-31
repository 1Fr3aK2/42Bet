FROM docker.elastic.co/beats/filebeat:8.19.18
COPY --chown=root:root filebeat.yml /usr/share/filebeat/filebeat.yml
# Filebeat refuses a config file writable by group/others. The copied file
# keeps the host's mode (664 with umask 002), so fix it in the image.
USER root
RUN chmod go-w /usr/share/filebeat/filebeat.yml
