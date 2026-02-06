# Use the Node.js Alpine image as a base to keep the image size small
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Create persistent cache directory
RUN mkdir -p /var/lib/wiim-now-playing

# Clone the GitHub repository
RUN apk add --no-cache git \
    && git clone https://github.com/Stargazer2026/wiim-now-playing.git . \
    && npm install \
    && apk del git

# Expose the port the app runs on (default 80, but can be adjusted if necessary)
EXPOSE 80

# Set the default port as an environment variable (change if needed)
ENV PORT 80

# Persist lyrics cache data
VOLUME ["/var/lib/wiim-now-playing"]

# Start the server
CMD ["node", "server/index.js"]
