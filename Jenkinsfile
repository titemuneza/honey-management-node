pipeline {
    agent any

    stages {
        stage('Checkout Code') {
            steps {
                git branch: 'main', url: 'https://github.com/titemuneza/honey-management-node.git'
            }
        }

        stage('Build Docker Image') {
            steps {
                sh "docker build -t muneza123/honey-management-node:latest ."
            }
        }

        stage('Push to Docker Hub') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub-creds', usernameVariable: 'DOCKER_USER', passwordVariable: 'DOCKER_PASS')]) {
                    sh "echo \$DOCKER_PASS | docker login -u \$DOCKER_USER --password-stdin"
                    sh "docker push muneza123/honey-management-node:latest"
                }
            }
        }

        stage('Deploy with Docker Compose') {
            steps {
                sh "docker compose pull"
                sh "docker compose up -d --remove-orphans"
            }
        }
    }
}
